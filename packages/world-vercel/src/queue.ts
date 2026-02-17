import { QueueClient, DuplicateMessageError } from '@vercel/queue';
import { handleCallback } from '@vercel/queue/web';
import {
  MessageId,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  QueuePayloadSchema,
  ValidQueueName,
} from '@workflow/world';
import * as z from 'zod';
import { type APIConfig, getHeaders, getHttpUrl } from './utils.js';

const MessageWrapper = z.object({
  payload: QueuePayloadSchema,
  queueName: ValidQueueName,
  deploymentId: z.string().optional(),
});

/**
 * Sleep Implementation via Message Delays
 *
 * VQS v3 supports `delaySeconds` which delays the initial delivery of a message.
 * We use this for implementing sleep() by creating a new message with the delay,
 * rather than using visibility timeouts on the same message.
 *
 * Benefits of this approach:
 * - Fresh 24-hour lifetime with each message (no message age tracking needed)
 * - Messages fire at the scheduled time (no short-circuit + recheck pattern)
 * - Simpler conceptual model: messages are triggers with delivery schedules
 *
 * For sleeps > 24 hours (max delay), we use chaining:
 * 1. Schedule message with max delay (~23h, leaving buffer)
 * 2. When it fires, workflow checks if sleep is complete
 * 3. If not, another delayed message is queued for remaining time
 * 4. Process repeats until the full sleep duration has elapsed
 *
 * The workflow runtime handles this via event sourcing - the `wait_created` event
 * stores the `resumeAt` timestamp, and on each invocation the runtime checks
 * if `now >= resumeAt`. If not, it returns another `timeoutSeconds`.
 *
 * These constants can be overridden via environment variables for testing.
 */
const MAX_DELAY_SECONDS = Number(
  process.env.VERCEL_QUEUE_MAX_DELAY_SECONDS || 82800 // 23 hours - leave 1h buffer before 24h retention limit
);

type QueueFunction = (
  queueName: ValidQueueName,
  payload: QueuePayload,
  opts?: QueueOptions
) => ReturnType<Queue['queue']>;

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config, { usingProxy });

  const clientOptions = {
    baseUrl: usingProxy ? baseUrl : undefined,
    // The proxy will strip `/queues` from the path, and add `/api` in front,
    // so this ends up being `/api/v3/topic` when arriving at the queue server,
    // which is the same as the default basePath in VQS client.
    basePath: usingProxy ? '/queues/v3/topic' : undefined,
    token: usingProxy ? config?.token : undefined,
    headers: Object.fromEntries(headers.entries()),
  };

  const queue: QueueFunction = async (
    queueName,
    payload,
    opts?: QueueOptions
  ) => {
    const deploymentId = opts?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID;
    if (!deploymentId) {
      throw new Error(
        'No deploymentId provided and VERCEL_DEPLOYMENT_ID environment variable is not set. ' +
          'Queue messages require a deployment ID to route correctly. ' +
          'Either set VERCEL_DEPLOYMENT_ID or provide deploymentId in options.'
      );
    }

    const client = new QueueClient({
      ...clientOptions,
      deploymentId,
    });

    // zod v3 doesn't have the `encode` method. We only support zod v4 officially,
    // but codebases that pin zod v3 are still common.
    const hasEncoder = typeof MessageWrapper.encode === 'function';
    if (!hasEncoder) {
      console.warn(
        'Using zod v3 compatibility mode for queue() calls - this may not work as expected'
      );
    }
    const encoder = hasEncoder
      ? MessageWrapper.encode
      : (data: z.infer<typeof MessageWrapper>) => data;

    const encoded = encoder({
      payload,
      queueName,
      deploymentId: opts?.deploymentId,
    });
    const sanitizedQueueName = queueName.replace(/[^A-Za-z0-9-_]/g, '-');
    try {
      const { messageId } = await client.sendMessage({
        queueName: sanitizedQueueName,
        payload: encoded,
        idempotencyKey: opts?.idempotencyKey,
        delaySeconds: opts?.delaySeconds,
        headers: opts?.headers,
      });
      return { messageId: MessageId.parse(messageId) };
    } catch (error) {
      if (error instanceof DuplicateMessageError) {
        return {
          messageId: MessageId.parse(
            `msg_duplicate_${error.idempotencyKey ?? opts?.idempotencyKey ?? 'unknown'}`
          ),
        };
      }
      throw error;
    }
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    const topicPattern = `${prefix}*`;

    return handleCallback(
      topicPattern,
      async (message, metadata) => {
        if (!message || !metadata) {
          return;
        }

        const { payload, queueName, deploymentId } =
          MessageWrapper.parse(message);

        const result = await handler(payload, {
          queueName,
          messageId: MessageId.parse(metadata.messageId),
          attempt: metadata.deliveryCount,
        });

        if (typeof result?.timeoutSeconds === 'number') {
          const delaySeconds = Math.min(
            result.timeoutSeconds,
            MAX_DELAY_SECONDS
          );
          await queue(queueName, payload, { deploymentId, delaySeconds });
        }
      },
      { client: new QueueClient(clientOptions) }
    );
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (!deploymentId) {
      throw new Error('VERCEL_DEPLOYMENT_ID environment variable is not set');
    }
    return deploymentId;
  };

  return { queue, createQueueHandler, getDeploymentId };
}
