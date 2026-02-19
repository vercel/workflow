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
import {
  Logger,
  makeWorkerUtils,
  run,
  type Runner,
  type WorkerUtils,
} from 'graphile-worker';
import { monotonicFactory } from 'ulid';
import { MessageData } from './message.js';
import type { PostgresWorldConfig } from './config.js';

// Redirect graphile-worker logs to stderr so CLI --json on stdout stays clean.
// TODO: When CI=1 suppresses logging, replace with conditional stdout (e.g. log to stdout when not in JSON/CI mode).
const stderrLogger = new Logger(
  () => (level: string, message: string, meta?: unknown) => {
    const line = [level, message, meta].filter(Boolean).join(' ') + '\n';
    process.stderr.write(line);
  }
);

/**
 * The Postgres queue works by creating two job types in graphile-worker:
 * - `workflow` for workflow jobs
 *   - `step` for step jobs
 *
 * When a message is queued, it is sent to graphile-worker with the appropriate job type.
 * When a job is processed, it is deserialized and then re-queued into the _local world_, showing that
 * we can reuse the local world, mix and match worlds to build
 * hybrid architectures, and even migrate between worlds.
 */
export type PostgresQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createQueue(config: PostgresWorldConfig): PostgresQueue {
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

  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
  let startPromise: Promise<void> | null = null;

  async function start(): Promise<void> {
    if (!startPromise) {
      startPromise = (async () => {
        workerUtils = await makeWorkerUtils({
          connectionString: config.connectionString,
          logger: stderrLogger,
        });
        await workerUtils.migrate();
        await setupListeners();
      })();
    }
    await startPromise;
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    await start();
    const [prefix, queueId] = parseQueueName(queue);
    const jobName = Queues[prefix];
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await workerUtils!.addJob(
      jobName,
      MessageData.encode({
        id: queueId,
        data: body,
        attempt: 1,
        messageId,
        idempotencyKey: opts?.idempotencyKey,
      }),
      {
        jobKey: opts?.idempotencyKey ?? messageId,
        maxAttempts: 3,
      }
    );
    return { messageId };
  };

  function createTaskHandler(queue: QueuePrefix) {
    return async (payload: unknown) => {
      const messageData = MessageData.parse(payload);
      const bodyStream = Stream.Readable.toWeb(
        Stream.Readable.from([messageData.data])
      );
      const body = await transport.deserialize(
        bodyStream as ReadableStream<Uint8Array>
      );
      const message = QueuePayloadSchema.parse(body);
      const queueName = `${queue}${messageData.id}` as const;
      // TODO: Custom headers from opts.headers are not propagated into MessageData.
      // To support this, MessageData schema would need to include a headers field
      // and the headers would need to be stored/retrieved from graphile-worker job data.
      await localWorld.queue(queueName, message, {
        idempotencyKey: messageData.idempotencyKey,
      });
    };
  }

  async function setupListeners() {
    const taskList: Record<string, (payload: unknown) => Promise<void>> = {};
    for (const [prefix, jobName] of Object.entries(Queues) as [
      QueuePrefix,
      string,
    ][]) {
      taskList[jobName] = createTaskHandler(prefix);
    }

    runner = await run({
      connectionString: config.connectionString,
      concurrency: config.queueConcurrency || 10,
      logger: stderrLogger,
      pollInterval: 500, // 500ms = 0.5s (graphile-worker uses LISTEN/NOTIFY when available)
      taskList,
    });
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    start,
    async close() {
      if (runner) {
        await runner.stop();
        runner = null;
      }
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
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
