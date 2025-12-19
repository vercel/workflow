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
});

// Queue timing constants - can be overridden via environment variables for testing
const VERCEL_QUEUE_MESSAGE_LIFETIME = Number(
  process.env.VERCEL_QUEUE_MESSAGE_LIFETIME ?? 86400 // 24 hours in seconds
);
const MESSAGE_LIFETIME_BUFFER = Number(
  process.env.VERCEL_QUEUE_MESSAGE_LIFETIME_BUFFER ?? 3600 // 1 hour buffer before lifetime expires
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
          const { payload, queueName } = MessageWrapper.parse(body);
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
              // Message is already at or past its safe limit, re-enqueue immediately
              // The new message will be delivered immediately, and the handler will
              // short-circuit by checking the persistent state (step.retryAfter or
              // wait_created event) and returning the remaining timeoutSeconds.
              console.log(
                `[Workflows] Message at lifetime limit (age: ${Math.round(messageAge)}s, ` +
                  `timeoutSeconds: ${result.timeoutSeconds}s, maxAllowedTimeout: ${Math.round(maxAllowedTimeout)}s, ` +
                  `lifetime: ${VERCEL_QUEUE_MESSAGE_LIFETIME}s, buffer: ${MESSAGE_LIFETIME_BUFFER}s). ` +
                  `Re-enqueueing to reset 24-hour clock.`
              );
              await queue(queueName, payload);

              // Return undefined to acknowledge the current message
              return undefined;
            } else if (result.timeoutSeconds > maxAllowedTimeout) {
              // Timeout would exceed message lifetime, clamp it
              console.log(
                `[Workflows] Clamping timeoutSeconds from ${result.timeoutSeconds}s to ${Math.round(maxAllowedTimeout)}s ` +
                  `(age: ${Math.round(messageAge)}s, lifetime: ${VERCEL_QUEUE_MESSAGE_LIFETIME}s, buffer: ${MESSAGE_LIFETIME_BUFFER}s).`
              );
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
