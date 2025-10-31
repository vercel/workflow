import { handleCallback, send } from '@vercel/queue';
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

const VERCEL_QUEUE_MAX_VISIBILITY = 82800; // 23 hours in seconds

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  const headers = getHeaders(config);
  if (usingProxy) {
    // If we're using a proxy for the Workflow API, we should also go
    // through the proxy for the queues API.
    process.env.VERCEL_QUEUE_BASE_URL = `${baseUrl}`;
    process.env.VERCEL_QUEUE_BASE_PATH = '/queues/v2/messages';
    if (config?.token) {
      process.env.VERCEL_QUEUE_TOKEN = config.token;
    }
    if (headers) {
      headers.forEach((value, key) => {
        const sanitizedKey = key.replaceAll('-', '__');
        process.env[`VERCEL_QUEUE_HEADER_${sanitizedKey}`] = value;
      });
    }
  }

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
