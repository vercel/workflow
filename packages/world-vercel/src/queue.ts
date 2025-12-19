import { Client } from '@vercel/queue';
import {
  MessageId,
  type Queue,
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
 * Message Lifetime Management
 *
 * Vercel Queue messages have a maximum lifetime of 24 hours. After this period,
 * messages are automatically deleted regardless of their visibility timeout.
 * This creates a problem for long-running sleep() or retryAfter delays that
 * exceed 24 hours - the message would be deleted before the handler fires.
 *
 * To handle delays longer than the message lifetime, we use a two-part strategy:
 *
 * 1. **Timeout Clamping**: If the requested timeoutSeconds would cause the message
 *    to expire before the next processing, we clamp the timeout to fit within
 *    the remaining message lifetime. The handler stores the target time in
 *    persistent state (step.retryAfter or wait_created event), so when the
 *    clamped timeout fires, it recalculates the remaining time and returns
 *    another timeout if needed.
 *
 * 2. **Message Re-enqueueing**: If the message is already at or past its safe
 *    lifetime limit (lifetime - buffer), we enqueue a fresh message and
 *    acknowledge the current one. The new message gets a fresh 24-hour clock.
 *    It fires immediately, and the handler short-circuits by checking the
 *    persistent state and returning the remaining timeoutSeconds.
 *
 * TODO: Once Vercel Queue supports NBF (not before) functionality, we can use
 * that when re-enqueueing to schedule the new message for the remaining delay
 * instead of having it fire immediately and short-circuit.
 *
 * These constants can be overridden via environment variables for testing.
 */
const VERCEL_QUEUE_MESSAGE_LIFETIME = Number(
  process.env.VERCEL_QUEUE_MESSAGE_LIFETIME || 86400 // 24 hours in seconds
);
const MESSAGE_LIFETIME_BUFFER = Number(
  process.env.VERCEL_QUEUE_MESSAGE_LIFETIME_BUFFER || 3600 // 1 hour buffer before lifetime expires
);

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config);
  const queueClient = new Client({
    baseUrl: usingProxy ? baseUrl : undefined,
    basePath: usingProxy ? '/queues/v2/messages' : undefined,
    token: usingProxy ? config?.token : undefined,
    headers: Object.fromEntries(headers.entries()),
  });

  const queue: Queue['queue'] = async (queueName, payload, opts) => {
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
    const { messageId } = await queueClient.send(
      sanitizedQueueName,
      encoded,
      opts
    );
    return { messageId: MessageId.parse(messageId) };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return queueClient.handleCallback({
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
            const now = Date.now();

            // Calculate how old this message is using the queue's createdAt timestamp
            const messageAge = (now - meta.createdAt.getTime()) / 1000; // Convert to seconds

            // Calculate the maximum timeout this message can handle before expiring
            const maxAllowedTimeout =
              VERCEL_QUEUE_MESSAGE_LIFETIME -
              MESSAGE_LIFETIME_BUFFER -
              messageAge;

            if (maxAllowedTimeout <= 0) {
              // Message is at its lifetime limit - re-enqueue to get a fresh 24-hour clock
              // Preserve the original deploymentId to ensure routing to the same deployment
              await queue(queueName, payload, { deploymentId });
              return undefined;
            } else if (result.timeoutSeconds > maxAllowedTimeout) {
              // Clamp timeout to fit within remaining message lifetime
              result.timeoutSeconds = maxAllowedTimeout;
            }
          }
          return result;
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
