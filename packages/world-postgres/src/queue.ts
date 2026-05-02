import * as Stream from 'node:stream';
import type { Transport } from '@vercel/queue';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
  WorkflowInvokePayloadSchema,
} from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import {
  Logger,
  makeWorkerUtils,
  type Runner,
  run,
  type WorkerUtils,
} from 'graphile-worker';
import type { Pool } from 'pg';
import { monotonicFactory } from 'ulid';
import { z } from 'zod/v4';
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
const GraphileHelpers = z.object({
  job: z.object({
    attempts: z.number().int().positive(),
  }),
});

type HttpExecutionResult =
  | { type: 'completed' }
  | { type: 'reschedule'; timeoutSeconds: number }
  | {
      type: 'error';
      status: number;
      text: string;
      headers: Record<string, string>;
    };

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

export function createQueue(
  config: PostgresWorldConfig,
  pool: Pool
): PostgresQueue {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const localWorld = createLocalWorld({ dataDir: undefined, port });

  // JSON transport that preserves Uint8Array values via a tagged
  // envelope ({ __type: 'Uint8Array', data: '<base64>' }).  Required
  // for the resilient start path where runInput.input (a Uint8Array)
  // is sent through the queue.
  const transport: Transport<unknown> = {
    contentType: 'application/json',
    serialize(value: unknown): Buffer {
      return Buffer.from(
        JSON.stringify(value, (_key, v) =>
          v instanceof Uint8Array
            ? { __type: 'Uint8Array', data: Buffer.from(v).toString('base64') }
            : v
        )
      );
    },
    async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString(), (_key, v) =>
        v !== null &&
        typeof v === 'object' &&
        v.__type === 'Uint8Array' &&
        typeof v.data === 'string'
          ? new Uint8Array(Buffer.from(v.data, 'base64'))
          : v
      );
    },
  };
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

  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  const inflightWorkflowRuns = new Map<
    string,
    Promise<'completed' | 'rescheduled'>
  >();
  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
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

  async function addGraphileJob({
    queuePrefix,
    queueId,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
    jobKey,
  }: {
    queuePrefix: QueuePrefix;
    queueId: string;
    body: Buffer | Uint8Array;
    messageId: MessageId;
    attempt: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    delaySeconds?: number;
    jobKey?: string;
  }) {
    const utils = workerUtils;
    if (!utils) {
      throw new Error('Postgres queue worker utils are not initialized');
    }

    const runAt =
      typeof delaySeconds === 'number' && delaySeconds > 0
        ? new Date(Date.now() + delaySeconds * 1000)
        : undefined;

    await utils.addJob(
      Queues[queuePrefix],
      MessageData.encode({
        id: queueId,
        data: Buffer.from(body),
        attempt,
        messageId,
        idempotencyKey,
        headers,
      }),
      {
        ...(jobKey ? { jobKey } : {}),
        ...(runAt ? { runAt } : {}),
        maxAttempts: 3,
      }
    );
  }

  async function resolveExecutionBaseUrl(): Promise<string> {
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
      return process.env.WORKFLOW_LOCAL_BASE_URL;
    }

    if (typeof port === 'number') {
      return `http://localhost:${port}`;
    }

    if (process.env.PORT) {
      return `http://localhost:${process.env.PORT}`;
    }

    const detectedPort = await getWorkflowPort();
    if (typeof detectedPort === 'number') {
      return `http://localhost:${detectedPort}`;
    }

    throw new Error('Unable to resolve base URL for workflow queue.');
  }

  function getQueueRoute(queueName: ValidQueueName): 'flow' | 'step' {
    if (queueName.startsWith('__wkf_step_')) {
      return 'step';
    }
    if (queueName.startsWith('__wkf_workflow_')) {
      return 'flow';
    }
    throw new Error('Unknown queue name prefix');
  }

  async function executeMessageOverHttp({
    queueName,
    messageId,
    attempt,
    body,
    headers: extraHeaders,
  }: {
    queueName: ValidQueueName;
    messageId: MessageId;
    attempt: number;
    body: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<HttpExecutionResult> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      'content-type': 'application/json',
      'x-vqs-queue-name': queueName,
      'x-vqs-message-id': messageId,
      'x-vqs-message-attempt': String(attempt),
    };
    const baseUrl = await resolveExecutionBaseUrl();
    const pathname = getQueueRoute(queueName);

    const response = await fetch(
      `${baseUrl}/.well-known/workflow/v1/${pathname}`,
      {
        method: 'POST',
        duplex: 'half',
        headers,
        body,
      } as any
    );
    const text = await response.text();

    if (!response.ok) {
      return {
        type: 'error',
        status: response.status,
        text,
        headers: Object.fromEntries(response.headers.entries()),
      };
    }

    try {
      const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
      if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
        return { type: 'reschedule', timeoutSeconds };
      }
    } catch {}

    return { type: 'completed' };
  }

  async function migratePgBossJobs(utils: WorkerUtils): Promise<void> {
    // Scenario A: Drizzle migration already ran — staging table exists
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
          maxAttempts: job.retry_limit ?? 3,
        });
      }
      await pool.query(`DROP TABLE "workflow"."_pgboss_pending_jobs"`);
      return;
    }

    // Scenario B: Drizzle migration didn't run — pgboss schema still exists
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
          maxAttempts: job.retry_limit ?? 3,
        });
      }
      await pool.query(`DROP SCHEMA pgboss CASCADE`);
    }
  }

  async function start(): Promise<void> {
    if (!startPromise) {
      startPromise = (async () => {
        try {
          workerUtils = await makeWorkerUtils({
            pgPool: pool,
            logger: graphileLogger,
            ...(config.noPreparedStatements
              ? { noPreparedStatements: true }
              : {}),
          });
          await workerUtils.migrate();
          await migratePgBossJobs(workerUtils);
          await setupListeners();
        } catch (err) {
          startPromise = null;
          throw err;
        }
      })();
    }
    await startPromise;
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    await start();
    const [queuePrefix, queueId] = parseQueueName(queue);
    const body = transport.serialize(message) as Buffer;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await addGraphileJob({
      queuePrefix,
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

  function createTaskHandler(queue: QueuePrefix) {
    return async (payload: unknown, helpers: unknown) => {
      const messageData = MessageData.parse(payload);
      const graphileAttempt = GraphileHelpers.safeParse(helpers);
      const attempt = graphileAttempt.success
        ? graphileAttempt.data.job.attempts
        : messageData.attempt;
      const queueName = `${queue}${messageData.id}` as const;
      const bodyStream = Stream.Readable.toWeb(
        Stream.Readable.from([messageData.data])
      );
      const body = await transport.deserialize(
        bodyStream as ReadableStream<Uint8Array>
      );
      QueuePayloadSchema.parse(body);
      const workflowRunSerializationKey =
        queue === '__wkf_workflow_'
          ? (() => {
              const workflowInvoke =
                WorkflowInvokePayloadSchema.safeParse(body);
              if (!workflowInvoke.success) {
                return undefined;
              }
              return `workflow:${workflowInvoke.data.runId}`;
            })()
          : undefined;
      const executeTask = async (): Promise<'completed' | 'rescheduled'> => {
        const result = await executeMessageOverHttp({
          queueName,
          messageId: messageData.messageId,
          attempt,
          body: messageData.data,
          headers: messageData.headers,
        });

        if (result.type === 'completed') {
          return 'completed';
        }

        if (result.type === 'reschedule') {
          // Schedule the follow-up job before we return so a crash cannot
          // lose the wake-up request.
          await addGraphileJob({
            queuePrefix: queue,
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
        }

        throw new Error(
          `[postgres world] Queue execution failed (${result.status}): ${result.text}`
        );
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

  async function setupListeners() {
    const taskList: Record<
      string,
      (payload: unknown, helpers: unknown) => Promise<void>
    > = {};
    for (const [prefix, jobName] of Object.entries(Queues) as [
      QueuePrefix,
      string,
    ][]) {
      taskList[jobName] = createTaskHandler(prefix);
    }

    runner = await run({
      pgPool: pool,
      concurrency: config.queueConcurrency || 10,
      logger: graphileLogger,
      pollInterval: 500, // 500ms = 0.5s (graphile-worker uses LISTEN/NOTIFY when available)
      taskList,
      ...(config.noPreparedStatements ? { noPreparedStatements: true } : {}),
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
      startPromise = null;
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
