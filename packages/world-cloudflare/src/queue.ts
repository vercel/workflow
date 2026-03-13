import type {
  Queue as QueueInterface,
  QueuePayload,
  ValidQueueName,
} from '@workflow/world';
import {
  MessageId as MessageIdSchema,
  QueuePayloadSchema,
} from '@workflow/world';
import { createLocalWorld, createQueueExecutor } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';
import type { CloudflareWorldConfig } from './config.js';

/** Message envelope stored in Cloudflare Queues */
interface QueueMessageEnvelope {
  queueName: ValidQueueName;
  payload: QueuePayload;
  messageId: string;
  attempt: number;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface CloudflareQueue extends QueueInterface {
  /** Process a batch of messages from the Cloudflare Queue consumer */
  handleQueueBatch(batch: MessageBatch<QueueMessageEnvelope>): Promise<void>;
}

export function createQueue(config: CloudflareWorldConfig): CloudflareQueue {
  const port = config.port;
  const localWorld = createLocalWorld({ dataDir: undefined, port });
  const executor = createQueueExecutor({ port });
  const generateMessageId = monotonicFactory();

  const createQueueHandler: QueueInterface['createQueueHandler'] = (
    prefix,
    handler
  ) => {
    const wrappedHandler = localWorld.createQueueHandler(prefix, handler);
    executor.registerHandler(prefix, wrappedHandler);
    return wrappedHandler;
  };

  const getDeploymentId: QueueInterface['getDeploymentId'] = async () => {
    return 'cloudflare';
  };

  const queue: QueueInterface['queue'] = async (queueName, message, opts) => {
    const messageId = MessageIdSchema.parse(`msg_${generateMessageId()}`);

    const envelope: QueueMessageEnvelope = {
      queueName,
      payload: message,
      messageId,
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
    };

    await config.queue.send(envelope, {
      // Cloudflare Queues supports delaySeconds natively
      ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}),
    });

    return { messageId };
  };

  const handleQueueBatch = async (
    batch: MessageBatch<QueueMessageEnvelope>
  ): Promise<void> => {
    for (const msg of batch.messages) {
      const envelope = msg.body;
      try {
        QueuePayloadSchema.parse(envelope.payload);

        const result = await executor.executeMessage({
          queueName: envelope.queueName,
          messageId: MessageIdSchema.parse(envelope.messageId),
          attempt: envelope.attempt,
          body: new TextEncoder().encode(JSON.stringify(envelope.payload)),
          headers: envelope.headers,
        });

        if (result.type === 'completed') {
          msg.ack();
        } else if (result.type === 'reschedule') {
          // Re-enqueue with delay for reschedule
          const rescheduledEnvelope: QueueMessageEnvelope = {
            ...envelope,
            attempt: envelope.attempt + 1,
          };
          await config.queue.send(rescheduledEnvelope, {
            delaySeconds: result.timeoutSeconds,
          });
          msg.ack();
        } else {
          msg.retry();
        }
      } catch {
        msg.retry();
      }
    }
  };

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    handleQueueBatch,
  };
}
