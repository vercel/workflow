import { Client, DuplicateMessageError } from '@vercel/queue';
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
  /**
   * The deployment ID to use when re-enqueueing the message.
   * This ensures the message is processed by the same deployment.
   */
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

/**
 * Extract known identifiers from a queue payload and return them as VQS headers.
 * This ensures observability headers are always set without relying on callers.
 */
function getHeadersFromPayload(
  payload: QueuePayload
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if ('runId' in payload && typeof payload.runId === 'string') {
    headers['x-workflow-run-id'] = payload.runId;
  }
  if ('workflowRunId' in payload && typeof payload.workflowRunId === 'string') {
    headers['x-workflow-run-id'] = payload.workflowRunId;
  }
  if ('stepId' in payload && typeof payload.stepId === 'string') {
    headers['x-workflow-step-id'] = payload.stepId;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

type QueueFunction = (
  queueName: ValidQueueName,
  payload: QueuePayload,
  opts?: QueueOptions
) => ReturnType<Queue['queue']>;

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config, { usingProxy });

  const baseClientOptions = {
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
    // Check if we have a deployment ID either from options or environment
    const deploymentId = opts?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID;
    if (!deploymentId) {
      throw new Error(
        'No deploymentId provided and VERCEL_DEPLOYMENT_ID environment variable is not set. ' +
          'Queue messages require a deployment ID to route correctly. ' +
          'Either set VERCEL_DEPLOYMENT_ID or provide deploymentId in options.'
      );
    }

    const sendMessageClient = new Client({
      ...baseClientOptions,
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
      // Store deploymentId in the message so it can be preserved when re-enqueueing
      deploymentId: opts?.deploymentId,
    });
    const sanitizedQueueName = queueName.replace(/[^A-Za-z0-9-_]/g, '-');
    try {
      const { messageId } = await sendMessageClient.send(
        sanitizedQueueName,
        encoded,
        {
          idempotencyKey: opts?.idempotencyKey,
          delaySeconds: opts?.delaySeconds,
          headers: {
            ...getHeadersFromPayload(payload),
            ...opts?.headers,
          },
        }
      );
      return { messageId: MessageId.parse(messageId) };
    } catch (error) {
      // Silently handle idempotency key conflicts - the message was already queued
      // This matches the behavior of world-local and world-postgres
      if (error instanceof DuplicateMessageError) {
        // Return a placeholder messageId since the original is not available from the error.
        // Callers using idempotency keys shouldn't depend on the returned messageId.
        // TODO: VQS should return the message ID of the existing message, or we should
        // stop expecting any world to include this
        return {
          messageId: MessageId.parse(
            `msg_duplicate_${error.idempotencyKey ?? opts?.idempotencyKey ?? 'unknown'}`
          ),
        };
      }
      throw error;
    }
  };

  const handleCallbackClient = new Client({
    ...baseClientOptions,
  });
  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return handleCallbackClient.handleCallback({
      [`${prefix}*`]: {
        default: async (body, meta) => {
          const { payload, queueName, deploymentId } =
            MessageWrapper.parse(body);
          const result = await handler(payload, {
            queueName,
            messageId: MessageId.parse(meta.messageId),
            attempt: meta.deliveryCount,
          });

          if (typeof result?.timeoutSeconds === 'number') {
            // Use delaySeconds approach: send new message with delay, then delete current
            // Clamp to max delay (23h) - for longer sleeps, the workflow will chain
            // multiple delayed messages until the full sleep duration has elapsed
            const delaySeconds = Math.min(
              result.timeoutSeconds,
              MAX_DELAY_SECONDS
            );

            // Send new message with delay BEFORE acknowledging current message
            // This ensures crash safety: if process dies after send but before ack,
            // we may get a duplicate invocation but won't lose the scheduled wakeup
            await queue(queueName, payload, {
              deploymentId,
              delaySeconds,
            });

            // Acknowledge current message by returning undefined
            return undefined;
          }

          return undefined;
        },
      },
    });
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
