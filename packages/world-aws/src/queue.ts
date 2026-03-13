import * as Stream from 'node:stream';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createLocalWorld, createQueueExecutor } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';
import z from 'zod';
import type { AwsWorldConfig } from './config.js';

/** Maximum SQS message delay (15 minutes). */
const MAX_SQS_DELAY_SECONDS = 900;

const MessageData = z.object({
  attempt: z.number().describe('The attempt number of the message'),
  messageId: z.string().describe('The unique ID of the message'),
  idempotencyKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  id: z.string().describe('The ID of the sub-queue (workflow/step name)'),
  data: z.string().describe('Base64-encoded message body'),
});
type MessageData = z.infer<typeof MessageData>;

const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;

/**
 * The AWS queue works by creating two SQS standard queues:
 * - One for workflow invocations
 * - One for step invocations
 *
 * When a message is queued, it is sent to SQS with the appropriate queue URL.
 * A background poller receives messages, deserializes them, and executes them
 * via the local world queue executor (same pattern as the Postgres world).
 *
 * SQS standard queues support per-message delay (up to 15 minutes), which maps
 * naturally to the workflow retry/sleep mechanism.
 */
export type AwsQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createQueue(
  config: AwsWorldConfig,
  sqsClient: SQSClient
): AwsQueue {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const localWorld = createLocalWorld({ dataDir: undefined, port });
  const executor = createQueueExecutor({ port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const Queues: Record<QueuePrefix, string | undefined> = {
    __wkf_workflow_: config.sqsWorkflowQueueUrl,
    __wkf_step_: config.sqsStepQueueUrl,
  };

  function getQueueUrl(prefix: QueuePrefix): string {
    const url = Queues[prefix];
    if (!url) {
      throw new Error(
        `SQS queue URL not configured for prefix "${prefix}". ` +
          `Set WORKFLOW_AWS_SQS_WORKFLOW_QUEUE_URL and WORKFLOW_AWS_SQS_STEP_QUEUE_URL.`
      );
    }
    return url;
  }

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    const wrappedHandler = localWorld.createQueueHandler(prefix, handler);
    executor.registerHandler(prefix, wrappedHandler);
    return wrappedHandler;
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'aws';
  };

  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  let polling = false;
  let pollTimers: ReturnType<typeof setTimeout>[] = [];
  let startPromise: Promise<void> | null = null;

  function markMessageCompleted(idempotencyKey: string) {
    completedMessages.delete(idempotencyKey);
    completedMessages.add(idempotencyKey);
    if (completedMessages.size > COMPLETED_IDEMPOTENCY_CACHE_LIMIT) {
      const oldestKey = completedMessages.values().next().value;
      if (oldestKey) {
        completedMessages.delete(oldestKey);
      }
    }
  }

  async function sendSqsMessage({
    queuePrefix,
    queueId,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
  }: {
    queuePrefix: QueuePrefix;
    queueId: string;
    body: Buffer | Uint8Array;
    messageId: MessageId;
    attempt: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    delaySeconds?: number;
  }) {
    const queueUrl = getQueueUrl(queuePrefix);
    const messageData: MessageData = {
      id: queueId,
      data: Buffer.from(body).toString('base64'),
      attempt,
      messageId,
      idempotencyKey,
      headers,
    };

    const effectiveDelay = Math.min(
      Math.max(0, delaySeconds ?? 0),
      MAX_SQS_DELAY_SECONDS
    );

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(messageData),
        DelaySeconds: effectiveDelay > 0 ? effectiveDelay : undefined,
        MessageGroupId: undefined, // standard queues don't use this
      })
    );
  }

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    await start();
    const [queuePrefix, queueId] = parseQueueName(queueName);
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    await sendSqsMessage({
      queuePrefix,
      queueId,
      body,
      messageId,
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
      delaySeconds: opts?.delaySeconds,
    });
    return { messageId };
  };

  async function processMessage(
    queuePrefix: QueuePrefix,
    rawMessage: string,
    receiptHandle: string
  ): Promise<void> {
    const messageData = MessageData.parse(JSON.parse(rawMessage));
    const queueUrl = getQueueUrl(queuePrefix);

    const executeTask = async (): Promise<'completed' | 'rescheduled'> => {
      const bodyBuffer = Buffer.from(messageData.data, 'base64');
      const bodyStream = Stream.Readable.toWeb(
        Stream.Readable.from([bodyBuffer])
      );
      const body = await transport.deserialize(
        bodyStream as ReadableStream<Uint8Array>
      );
      QueuePayloadSchema.parse(body);
      const queueName = `${queuePrefix}${messageData.id}` as const;
      const result = await executor.executeMessage({
        queueName,
        messageId: MessageId.parse(messageData.messageId),
        attempt: messageData.attempt,
        body: bodyBuffer,
        headers: messageData.headers,
      });

      if (result.type === 'completed') {
        return 'completed';
      }

      if (result.type === 'reschedule') {
        // Schedule the follow-up message before deleting the current one
        await sendSqsMessage({
          queuePrefix,
          queueId: messageData.id,
          body: bodyBuffer,
          messageId: MessageId.parse(messageData.messageId),
          attempt: messageData.attempt + 1,
          idempotencyKey: messageData.idempotencyKey,
          headers: messageData.headers,
          delaySeconds: result.timeoutSeconds,
        });
        return 'rescheduled';
      }

      throw new Error(
        `[aws world] Queue execution failed (${result.status}): ${result.text}`
      );
    };

    const idempotencyKey = messageData.idempotencyKey;
    if (!idempotencyKey) {
      await executeTask();
      // Delete message from SQS after processing
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        })
      );
      return;
    }

    if (completedMessages.has(idempotencyKey)) {
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        })
      );
      return;
    }

    const existing = inflightMessages.get(idempotencyKey);
    if (existing) {
      await existing;
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        })
      );
      return;
    }

    const execution = executeTask()
      .then((result) => {
        if (result === 'completed') {
          markMessageCompleted(idempotencyKey);
        }
      })
      .finally(() => {
        inflightMessages.delete(idempotencyKey);
      });
    inflightMessages.set(idempotencyKey, execution);
    await execution;
    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      })
    );
  }

  function startPolling(queuePrefix: QueuePrefix) {
    const queueUrl = Queues[queuePrefix];
    if (!queueUrl) return;

    const concurrency = config.queueConcurrency ?? 10;
    const pollInterval = config.pollIntervalMs ?? 1000;

    async function poll() {
      if (!polling) return;

      try {
        const result = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: Math.min(concurrency, 10), // SQS max is 10
            WaitTimeSeconds: 20, // Long polling
          })
        );

        if (result.Messages?.length) {
          await Promise.all(
            result.Messages.map(async (msg) => {
              if (msg.Body && msg.ReceiptHandle) {
                try {
                  await processMessage(
                    queuePrefix,
                    msg.Body,
                    msg.ReceiptHandle
                  );
                } catch (err) {
                  // Log error but don't crash the poller
                  const pipe =
                    process.env.WORKFLOW_JSON_MODE === '1'
                      ? process.stdout
                      : process.stderr;
                  pipe.write(`[aws world] Error processing message: ${err}\n`);
                }
              }
            })
          );
        }
      } catch (err: any) {
        if (polling) {
          const pipe =
            process.env.WORKFLOW_JSON_MODE === '1'
              ? process.stdout
              : process.stderr;
          pipe.write(`[aws world] Polling error: ${err}\n`);
        }
      }

      if (polling) {
        const timer = setTimeout(poll, pollInterval);
        pollTimers.push(timer);
      }
    }

    // Start immediately
    poll();
  }

  async function start(): Promise<void> {
    if (!startPromise) {
      startPromise = (async () => {
        polling = true;
        const prefixes: QueuePrefix[] = ['__wkf_workflow_', '__wkf_step_'];
        for (const prefix of prefixes) {
          startPolling(prefix);
        }
      })();
    }
    await startPromise;
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    start,
    async close() {
      polling = false;
      for (const timer of pollTimers) {
        clearTimeout(timer);
      }
      pollTimers = [];
      startPromise = null;
      await executor.close();
      await localWorld.close?.();
    },
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
