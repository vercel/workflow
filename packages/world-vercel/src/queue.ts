import { handleCallback, send } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  ValidQueueName,
} from '@workflow/world';
import * as z from 'zod';
import { type APIConfig, getHttpUrl } from './utils.js';

const MessageWrapper = z.object({
  payload: QueuePayloadSchema,
  queueName: ValidQueueName,
});

export function createQueue(config?: APIConfig): Queue {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  if (usingProxy) {
    // If we're using a proxy for the Workflow API, we should also go
    // through the proxy for the queues API.
    process.env.VERCEL_QUEUE_BASE_URL = `${baseUrl}/queues`;
    if (config?.token) {
      process.env.VERCEL_QUEUE_TOKEN = config.token;
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
        default: (body, meta) => {
          const { payload, queueName } = MessageWrapper.parse(body);
          return handler(payload, {
            queueName,
            messageId: MessageId.parse(meta.messageId),
            attempt: meta.deliveryCount,
          });
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
