import { z } from 'zod/v4';
import {
  MessageId,
  type QueueHandler,
  type QueuePrefix,
  ValidQueueName,
} from './queue.js';
import { deserializeQueueMessage } from './queue-json.js';

const QueueMessageHeaders = z.object({
  'x-vqs-queue-name': ValidQueueName,
  'x-vqs-message-id': MessageId,
  'x-vqs-message-attempt': z.coerce.number().int().positive(),
});

/**
 * Implements the framework-facing HTTP delivery contract used by Worlds with
 * an authenticated remote queue producer. Direct-delivery Worlds should
 * register their handler themselves and return 404 instead.
 */
export function createFetchQueueHandler(
  prefix: QueuePrefix,
  handler: QueueHandler,
  options?: { maxTimeoutSeconds?: number }
): (req: Request) => Promise<Response> {
  return async (req) => {
    const headers = QueueMessageHeaders.safeParse(
      Object.fromEntries(req.headers)
    );
    if (!headers.success || !req.body) {
      return Response.json(
        {
          error: !req.body
            ? 'Missing request body'
            : 'Missing required headers',
        },
        { status: 400 }
      );
    }

    const queueName = headers.data['x-vqs-queue-name'];
    if (!queueName.startsWith(prefix)) {
      return Response.json({ error: 'Unhandled queue' }, { status: 400 });
    }

    const message = deserializeQueueMessage(
      new Uint8Array(await req.arrayBuffer())
    );
    try {
      const result = await handler(message, {
        abortSignal: req.signal,
        attempt: headers.data['x-vqs-message-attempt'],
        queueName,
        messageId: headers.data['x-vqs-message-id'],
      });
      if (!result) return Response.json({ ok: true });

      return Response.json({
        timeoutSeconds: Math.min(
          result.timeoutSeconds,
          options?.maxTimeoutSeconds ?? Number.POSITIVE_INFINITY
        ),
      });
    } catch (error) {
      return Response.json(String(error), { status: 500 });
    }
  };
}
