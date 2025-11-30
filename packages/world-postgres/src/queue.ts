import * as Stream from 'node:stream';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import type PgBoss from 'pg-boss';
import { monotonicFactory } from 'ulid';
import { MessageData } from './boss.js';
import type { PostgresWorldConfig } from './config.js';

/**
 * The Postgres queue works by creating two job types in pg-boss:
 * - `workflow` for workflow jobs
 *   - `step` for step jobs
 *
 * When a message is queued, it is sent to pg-boss with the appropriate job type.
 * When a job is processed, it is deserialized and then re-queued into the _local world_, showing that
 * we can reuse the local world, mix and match worlds to build
 * hybrid architectures, and even migrate between worlds.
 */
export function createQueue(
  boss: PgBoss,
  config: PostgresWorldConfig
): Queue & { start(): Promise<void> } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const localWorld = createLocalWorld({ dataDir: undefined, port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const createQueueHandler = localWorld.createQueueHandler;

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres';
  };

  const createdQueues = new Map<string, Promise<void>>();

  function createQueue(name: string) {
    let createdQueue = createdQueues.get(name);
    if (!createdQueue) {
      createdQueue = boss.createQueue(name);
      createdQueues.set(name, createdQueue);
    }
    return createdQueue;
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    await boss.start();
    const [prefix, queueId] = parseQueueName(queue);
    const jobName = Queues[prefix];
    await createQueue(jobName);
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await boss.send({
      name: jobName,
      options: {
        singletonKey: opts?.idempotencyKey ?? messageId,
        retryLimit: 3,
      },
      data: MessageData.encode({
        id: queueId,
        data: body,
        attempt: 1,
        messageId,
        idempotencyKey: opts?.idempotencyKey,
      }),
    });
    return { messageId };
  };

  async function setupListener(queue: QueuePrefix, jobName: string) {
    await createQueue(jobName);
    await Promise.all(
      Array.from({ length: config.queueConcurrency || 10 }, async () => {
        await boss.work(
          jobName,
          {
            // The default is 2s, which is far too slow for running steps in quick succession.
            // The min is 0.5s, which is still too slow. We should move to a pg NOTIFY/LISTEN-based job system.
            pollingIntervalSeconds: 0.5,
          },
          work
        );
      })
    );

    async function work([job]: PgBoss.Job[]) {
      const messageData = MessageData.parse(job.data);
      const bodyStream = Stream.Readable.toWeb(
        Stream.Readable.from([messageData.data])
      );
      const body = await transport.deserialize(
        bodyStream as ReadableStream<Uint8Array>
      );
      const message = QueuePayloadSchema.parse(body);
      const queueName = `${queue}${messageData.id}` as const;
      await localWorld.queue(queueName, message, {
        idempotencyKey: messageData.idempotencyKey,
      });
    }
  }

  async function setupListeners() {
    for (const [prefix, jobName] of Object.entries(Queues) as [
      QueuePrefix,
      string,
    ][]) {
      await setupListener(prefix, jobName);
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      boss = await boss.start();
      await setupListeners();
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
