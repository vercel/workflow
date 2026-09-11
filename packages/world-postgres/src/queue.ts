import assert from 'node:assert/strict';
import {
  getQueueTopicPrefix,
  MessageId,
  parseQueueName,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  resolveQueueNamespace,
  type ValidQueueName,
} from '@workflow/world';
import {
  type JobHelpers,
  Logger,
  makeWorkerUtils,
  type Runner,
  run,
  type Task,
  type WorkerUtils,
} from 'graphile-worker';
import type { Pool } from 'pg';
import { monotonicFactory } from 'ulid';
import type { PostgresWorldConfig } from './config.js';
import { MessageData } from './message.js';

function createGraphileLogger() {
  const isJsonMode = () => process.env.WORKFLOW_JSON_MODE === '1';
  const isVerbose = () => Boolean(process.env.DEBUG);

  return new Logger(() => (level: string, message: string, meta?: unknown) => {
    if (isJsonMode()) return;
    if ((level === 'debug' || level === 'info') && !isVerbose()) return;
    const pipe = level === 'error' ? process.stderr : process.stdout;
    if (meta) {
      pipe.write(
        `[Graphile Worker] ${message} ${JSON.stringify(meta, null, 2)}\n`
      );
    } else {
      pipe.write(`[Graphile Worker] ${message}\n`);
    }
  });
}

const graphileLogger = createGraphileLogger();
const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;
// Core records MAX_DELIVERIES_EXCEEDED on delivery 49.
const MAX_GRAPHILE_JOB_ATTEMPTS = 49;
type QueueHandler = Parameters<Queue['createQueueHandler']>[1];
type ConsumerState =
  | { status: 'idle' }
  | { status: 'starting'; promise: Promise<Runner> }
  | { status: 'running'; runner: Runner }
  | { status: 'closing'; promise: Promise<void> }
  | { status: 'closed' };

export function encodeQueueMessage(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(value, (_key, item) =>
      item instanceof Uint8Array
        ? {
            __type: 'Uint8Array',
            data: Buffer.from(item).toString('base64'),
          }
        : item
    )
  );
}

function decodeQueueMessage(data: Buffer): unknown {
  return JSON.parse(data.toString(), (_key, item) =>
    item !== null &&
    typeof item === 'object' &&
    item.__type === 'Uint8Array' &&
    typeof item.data === 'string'
      ? new Uint8Array(Buffer.from(item.data, 'base64'))
      : item
  );
}

/**
 * The Postgres queue stores messages under one graphile-worker flow task.
 */
export type PostgresQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createQueue(
  config: PostgresWorldConfig,
  pool: Pool
): PostgresQueue {
  const generateMessageId = monotonicFactory();
  const jobQueueName = `${config.jobPrefix || 'workflow_'}flows`;
  const workflowPrefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(config.namespace)
  );

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres';
  };

  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  const inflightWorkflowRuns = new Map<
    string,
    Promise<'completed' | 'rescheduled'>
  >();
  let consumer: ConsumerState = { status: 'idle' };
  let registeredHandler: QueueHandler | undefined;
  let workerUtilsPromise: Promise<WorkerUtils> | undefined;

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

  function ensureWorkerUtils(): Promise<WorkerUtils> {
    assert.notEqual(consumer.status, 'closed', 'Postgres queue is closed');
    if (!workerUtilsPromise) {
      let initialization!: Promise<WorkerUtils>;
      initialization = makeWorkerUtils({
        pgPool: pool,
        logger: graphileLogger,
      })
        .then(async (utils) => {
          await migratePgBossJobs(utils);
          return utils;
        })
        .catch((error) => {
          if (workerUtilsPromise === initialization) {
            workerUtilsPromise = undefined;
          }
          throw error;
        });
      workerUtilsPromise = initialization;
    }
    return workerUtilsPromise;
  }

  async function addGraphileJob({
    queueId,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
    jobKey,
  }: {
    queueId: string;
    body: Buffer;
    messageId: MessageId;
    attempt: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    delaySeconds?: number;
    jobKey?: string;
  }) {
    const utils = await ensureWorkerUtils();

    const runAt =
      typeof delaySeconds === 'number' && delaySeconds > 0
        ? new Date(Date.now() + delaySeconds * 1000)
        : undefined;

    await utils.addJob(
      jobQueueName,
      MessageData.encode({
        id: queueId,
        data: body,
        attempt,
        messageId,
        idempotencyKey,
        headers,
      }),
      {
        ...(jobKey ? { jobKey } : {}),
        ...(runAt ? { runAt } : {}),
        maxAttempts: MAX_GRAPHILE_JOB_ATTEMPTS,
      }
    );
  }

  async function migratePgBossJobs(utils: WorkerUtils): Promise<void> {
    // Scenario A: Drizzle migration already ran, so the staging table exists
    const hasStaging = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'workflow'
        AND table_name = '_pgboss_pending_jobs'
      ) AS exists`
    );
    if (hasStaging.rows[0]?.exists) {
      const jobs = await pool.query(
        `SELECT name, data, singleton_key, retry_limit
        FROM "workflow"."_pgboss_pending_jobs"`
      );
      for (const job of jobs.rows) {
        await utils.addJob(job.name, job.data as Record<string, unknown>, {
          jobKey: job.singleton_key ?? undefined,
          maxAttempts: Math.max(
            job.retry_limit ?? 0,
            MAX_GRAPHILE_JOB_ATTEMPTS
          ),
        });
      }
      await pool.query(`DROP TABLE "workflow"."_pgboss_pending_jobs"`);
      return;
    }

    // Scenario B: Drizzle migration didn't run, so the pgboss schema still
    // exists
    const hasPgBoss = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = 'pgboss'
      ) AS exists`
    );
    if (hasPgBoss.rows[0]?.exists) {
      const jobs = await pool.query(
        `SELECT name, data, singleton_key, retry_limit
        FROM pgboss.job
        WHERE state IN ('created', 'retry')`
      );
      for (const job of jobs.rows) {
        await utils.addJob(job.name, job.data as Record<string, unknown>, {
          jobKey: job.singleton_key ?? undefined,
          maxAttempts: Math.max(
            job.retry_limit ?? 0,
            MAX_GRAPHILE_JOB_ATTEMPTS
          ),
        });
      }
      await pool.query(`DROP SCHEMA pgboss CASCADE`);
    }
  }

  async function start(): Promise<void> {
    if (consumer.status === 'closed' || consumer.status === 'closing') {
      throw new Error('Postgres queue is closed');
    }
    if (!registeredHandler) {
      throw new Error(
        'Import the generated flow route before starting the Postgres World'
      );
    }
    if (consumer.status === 'running') {
      return;
    }
    if (consumer.status === 'starting') {
      await consumer.promise;
      return;
    }

    let starting!: Promise<Runner>;
    starting = ensureWorkerUtils()
      .then(() => startRunner())
      .then(
        (runner) => {
          if (consumer.status === 'starting' && consumer.promise === starting) {
            consumer = { status: 'running', runner };
          }
          return runner;
        },
        (error) => {
          if (consumer.status === 'starting' && consumer.promise === starting) {
            consumer = { status: 'idle' };
          }
          throw error;
        }
      );
    consumer = { status: 'starting', promise: starting };
    await starting;
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    const { id: queueId } = parseQueueName(queue);
    const body = encodeQueueMessage(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await addGraphileJob({
      queueId,
      body,
      messageId,
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
      delaySeconds: opts?.delaySeconds,
      jobKey: opts?.idempotencyKey ?? messageId,
    });
    return { messageId };
  };

  function createTaskHandler(queue: QueuePrefix): Task {
    return async (payload: unknown, helpers: JobHelpers) => {
      const messageData = MessageData.parse(payload);
      const attempt = messageData.attempt + helpers.job.attempts - 1;
      const queueName = `${queue}${messageData.id}` as ValidQueueName;
      const message = QueuePayloadSchema.parse(
        decodeQueueMessage(messageData.data)
      );
      const workflowRunSerializationKey =
        !('__healthCheck' in message) && !message.stepId
          ? `workflow:${message.runId}`
          : undefined;
      const executeTask = async (): Promise<'completed' | 'rescheduled'> => {
        assert.ok(registeredHandler, 'Postgres queue handler is missing');
        const result = await registeredHandler(message, {
          attempt,
          queueName,
          messageId: messageData.messageId,
        });
        if (!result) return 'completed';

        // Schedule the follow-up job before we return so a crash cannot lose
        // the wake-up request.
        await addGraphileJob({
          queueId: messageData.id,
          body: messageData.data,
          messageId: messageData.messageId,
          attempt: attempt + 1,
          idempotencyKey: messageData.idempotencyKey,
          headers: messageData.headers,
          delaySeconds: result.timeoutSeconds,
          jobKey: messageData.idempotencyKey ?? messageData.messageId,
        });
        return 'rescheduled';
      };

      const idempotencyKey = messageData.idempotencyKey;
      if (!idempotencyKey) {
        if (workflowRunSerializationKey) {
          // Preserve step fan-out while preventing two workflow replays from
          // mutating the same run's event log at the same time.
          const previous = inflightWorkflowRuns.get(
            workflowRunSerializationKey
          );
          const execution = (previous ?? Promise.resolve())
            .catch(() => {})
            .then(() => executeTask())
            .finally(() => {
              if (
                inflightWorkflowRuns.get(workflowRunSerializationKey) ===
                execution
              ) {
                inflightWorkflowRuns.delete(workflowRunSerializationKey);
              }
            });
          inflightWorkflowRuns.set(workflowRunSerializationKey, execution);
          await execution;
          return;
        }

        await executeTask();
        return;
      }

      if (completedMessages.has(idempotencyKey)) {
        return;
      }

      const existing = inflightMessages.get(idempotencyKey);
      if (existing) {
        await existing;
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
    };
  }

  async function startRunner(): Promise<Runner> {
    return run({
      pgPool: pool,
      // Default of 50 is high enough to avoid worker-pool exhaustion in
      // workflows that use parent→child polling patterns (e.g. awaiting a
      // child workflow via `childRun.returnValue` inside the parent).
      // Every such poll holds a worker slot for the duration of the child
      // run. Recursive workflows like `fibonacciWorkflow` fan out rapidly.
      // fib(6) produces ~24 concurrent polling steps at peak, and at
      // concurrency=10 (the previous default) it would deadlock on the
      // default Postgres setup. See packages/core/src/runtime/run.ts and
      // docs/content/docs/changelog/eager-processing.mdx for context.
      concurrency: config.queueConcurrency || 50,
      logger: graphileLogger,
      ...(config.applicationManagedShutdown === true && {
        noHandleSignals: true,
      }),
      pollInterval: 500, // 500ms = 0.5s (graphile-worker uses LISTEN/NOTIFY when available)
      taskList: { [jobQueueName]: createTaskHandler(workflowPrefix) },
    });
  }

  async function stopRunner(runner: Runner): Promise<void> {
    try {
      await runner.stop();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Runner is already stopped'
      ) {
        throw error;
      }
    }
    await runner.promise.catch(() => {});
  }

  async function closeConsumer(
    previous: Extract<
      ConsumerState,
      { status: 'idle' | 'starting' | 'running' }
    >
  ): Promise<void> {
    let runner: Runner | undefined;
    try {
      if (previous.status === 'starting') {
        runner = await previous.promise.catch(() => undefined);
      } else if (previous.status === 'running') {
        runner = previous.runner;
      }
      if (runner) await stopRunner(runner);

      const workerUtils = await workerUtilsPromise;
      await workerUtils?.release();
      workerUtilsPromise = undefined;
      consumer = { status: 'closed' };
    } catch (error) {
      consumer = runner ? { status: 'running', runner } : { status: 'idle' };
      throw error;
    }
  }

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    assert.equal(prefix, workflowPrefix);
    switch (consumer.status) {
      case 'idle':
      case 'starting':
      case 'running':
        registeredHandler = handler;
        break;
      case 'closing':
      case 'closed':
        throw new Error('Postgres queue is closed');
      default:
        consumer satisfies never;
    }
    return async () => new Response(null, { status: 404 });
  };

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    start,
    async close() {
      if (consumer.status === 'closed') return;
      if (consumer.status === 'closing') return consumer.promise;

      const previous = consumer;
      const closing = closeConsumer(previous);
      consumer = { status: 'closing', promise: closing };
      await closing;
    },
  };
}
