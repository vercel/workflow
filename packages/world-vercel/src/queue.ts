import { Client } from '@vercel/queue';
import {
  MessageId,
  type Queue,
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
   * Timestamp when this message was first enqueued.
   * Used to track message age and re-enqueue before the 24-hour message lifetime expires.
   */
  messageQueuedAt: z.coerce.date().optional(),
});

const VERCEL_QUEUE_MAX_VISIBILITY = 39600; // 11 hours in seconds
const VERCEL_QUEUE_MESSAGE_LIFETIME = 86400; // 24 hours in seconds
const MESSAGE_LIFETIME_BUFFER = 3600; // 1 hour buffer before lifetime expires

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config);
  const queueClient = new Client({
    baseUrl: usingProxy ? baseUrl : undefined,
    basePath: usingProxy ? '/queues/v2/messages' : undefined,
    token: usingProxy ? config?.token : undefined,
    headers: Object.fromEntries(headers.entries()),
  });

  /**
   * Internal function to send a message to the queue with optional messageQueuedAt override.
   * This is used both for initial queue() calls and for re-enqueueing when extending message lifetime.
   */
  const sendMessage = async (
    queueName: ValidQueueName,
    payload: QueuePayload,
    messageQueuedAt: Date,
    opts?: Parameters<Queue['queue']>[2]
  ) => {
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
      messageQueuedAt,
    });
    const sanitizedQueueName = queueName.replace(/[^A-Za-z0-9-_]/g, '-');
    const { messageId } = await queueClient.send(
      sanitizedQueueName,
      encoded,
      opts
    );
    return { messageId: MessageId.parse(messageId) };
  };

  const queue: Queue['queue'] = async (queueName, x, opts) => {
    return sendMessage(queueName, x, new Date(), opts);
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return queueClient.handleCallback({
      [`${prefix}*`]: {
        default: async (body, meta) => {
          const { payload, queueName, messageQueuedAt } =
            MessageWrapper.parse(body);
          const result = await handler(payload, {
            queueName,
            messageId: MessageId.parse(meta.messageId),
            attempt: meta.deliveryCount,
          });
          if (typeof result?.timeoutSeconds === 'number') {
            const now = Date.now();

            // Calculate how old this message is
            const messageAge = messageQueuedAt
              ? (now - messageQueuedAt.getTime()) / 1000 // Convert to seconds
              : 0;

            // Calculate when the message would next be processed
            const timeUntilNextProcessing = Math.min(
              result.timeoutSeconds,
              VERCEL_QUEUE_MAX_VISIBILITY
            );
            const messageAgeAtNextProcessing =
              messageAge + timeUntilNextProcessing;

            // If the message would exceed its lifetime before next processing,
            // we need to re-enqueue a fresh message and acknowledge this one
            if (
              messageAgeAtNextProcessing >
              VERCEL_QUEUE_MESSAGE_LIFETIME - MESSAGE_LIFETIME_BUFFER
            ) {
              // Re-enqueue with a fresh messageQueuedAt to reset the 24-hour clock.
              // The new message will be delivered immediately, and the handler will
              // short-circuit by checking the persistent state (step.retryAfter or
              // wait_created event) and returning the remaining timeoutSeconds.
              await sendMessage(queueName, payload, new Date());

              // Return undefined to acknowledge the current message
              return undefined;
            }

            // Otherwise, just clamp the timeout to the max visibility
            const adjustedTimeoutSeconds = Math.min(
              result.timeoutSeconds,
              VERCEL_QUEUE_MAX_VISIBILITY
            );

            if (adjustedTimeoutSeconds !== result.timeoutSeconds) {
              result.timeoutSeconds = adjustedTimeoutSeconds;
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
