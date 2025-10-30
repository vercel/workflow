import { handleCallback, send } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  ValidQueueName,
} from '@workflow/world';
import * as z from 'zod';

const MessageWrapper = z.object({
  payload: QueuePayloadSchema,
  queueName: ValidQueueName,
});

const VERCEL_QUEUE_MAX_VISIBILITY = 82800; // 23 hours in seconds

export function createQueue(): Queue {
  const queue: Queue['queue'] = async (queueName, x, opts) => {
    const encoded = MessageWrapper.encode({
      payload: x,
      queueName,
    });
    const sanitizedQueueName = queueName.replace(/[^A-Za-z0-9-_]/g, '-');
    const { messageId } = await send(sanitizedQueueName, encoded, opts);
    return { messageId: MessageId.parse(messageId) };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return handleCallback({
      [`${prefix}*`]: {
        default: async (body, meta) => {
          const { payload, queueName } = MessageWrapper.parse(body);
          const result = await handler(payload, {
            queueName,
            messageId: MessageId.parse(meta.messageId),
            attempt: meta.deliveryCount,
          });
          if (typeof result?.timeoutSeconds === 'number') {
            // For Vercel Queue, enforce the max visibility limit:
            //   - When a step function throws a `RetryableError`, the retryAfter timestamp is updated and stored on the Step document
            result.timeoutSeconds = Math.min(
              result.timeoutSeconds,
              VERCEL_QUEUE_MAX_VISIBILITY
            );
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
