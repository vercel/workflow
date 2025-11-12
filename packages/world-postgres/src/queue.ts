import Stream from 'node:stream';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { MessageData, type QueueDriver } from './queue-drivers/types.js';

const QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_POSTGRES_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
  Infinity;

/**
 * The Postgres queue works by creating two job types in pg-boss:
 * - `workflow` for workflow jobs
 *   - `step` for step jobs
 *
 * When a message is queued, it is prepared and sent to the queue driver with.
 * When a job is processed, it is deserialized and then re-queued into the _embedded world_, showing that
 * we can reuse the embedded world, mix and match worlds to build
 * hybrid architectures, and even migrate between worlds.
 */
export function createQueue(queueImplementation: QueueDriver): Queue {
  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres';
  };

  const queue: Queue['queue'] = async (queue, message, opts) => {
    const body = transport.serialize(message);
    const [prefix, queueId] = parseQueueName(queue);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    const payload = {
      id: queueId,
      data: body,
      attempt: 1,
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName: `${prefix}${queueId}`,
    };

    switch (prefix) {
      case '__wkf_step_':
        await queueImplementation.pushStep(payload);
        break;

      case '__wkf_workflow_':
        await queueImplementation.pushFlow(payload);
        break;
    }

    return { messageId };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (
    _prefix,
    handler
  ) => {
    return async (req) => {
      const reqBody = await req.json();
      const messageData = MessageData.parse(reqBody);
      const bodyStream = Stream.Readable.toWeb(
        Stream.Readable.from([messageData.data])
      );

      const body = await transport.deserialize(
        bodyStream as ReadableStream<Uint8Array>
      );

      const message = QueuePayloadSchema.parse(body);

      if (!isValidQueueName(messageData.queueName)) {
        return Response.json(
          { error: `Invalid queue name: ${messageData.queueName}` },
          { status: 400 }
        );
      }

      try {
        const result = await handler(message, {
          attempt: messageData.attempt,
          queueName: messageData.queueName,
          messageId: messageData.messageId,
        });

        let timeoutSeconds: number | null = null;
        if (typeof result?.timeoutSeconds === 'number') {
          timeoutSeconds = Math.min(
            result.timeoutSeconds,
            QUEUE_MAX_VISIBILITY
          );
        }

        if (timeoutSeconds) {
          return Response.json({ timeoutSeconds }, { status: 503 });
        }

        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
  };
}

const parseQueueName = (name: ValidQueueName): [QueuePrefix, string] => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];

  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      return [prefix, name.slice(prefix.length)];
    }
  }

  throw new Error(`Invalid queue name: ${name}`);
};

function isValidQueueName(name: string): name is ValidQueueName {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];

  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}
