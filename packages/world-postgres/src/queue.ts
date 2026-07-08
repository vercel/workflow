import assert from 'node:assert/strict';
import type { Transport } from '@vercel/queue';
import {
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
  createWorkflowUrl,
} from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  getQueuePrefixKind,
  getQueueTopicPrefix,
  MessageId,
  parseQueueName,
  type Queue,
  type QueuePayload,
  QueuePayloadSchema,
  type QueuePrefix,
  resolveQueueNamespace,
  ValidQueueName,
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
import { z } from 'zod/v4';
import type { PostgresWorldConfig } from './config.js';
import { MessageData } from './message.js';

const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;
const HEALTH_PROBE_TIMEOUT_MS = 500;
const DEFERRED_EXECUTION_DELAY_SECONDS = 1;

const TimeoutSeconds = z.number().nonnegative();
const QueueConcurrency = z.number().int().positive();
const QueueHandlerHttpResponse = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ timeoutSeconds: TimeoutSeconds }).strict(),
]);
const QueueHandlerHeaders = z.object({
  'x-vqs-queue-name': ValidQueueName,
  'x-vqs-message-id': MessageId,
  'x-vqs-message-attempt': z.coerce.number().int().positive(),
});

type QueueHandler = Parameters<Queue['createQueueHandler']>[1];
type QueueHandlerResult = Awaited<ReturnType<QueueHandler>>;

type QueueExecutor =
  | { type: 'direct'; handler: QueueHandler }
  | { type: 'http'; baseUrl: string }
  | { type: 'unavailable' };

type Delivery = {
  prefix: QueuePrefix;
  queueName: ValidQueueName;
  messageData: MessageData;
  message: QueuePayload;
  attempt: number;
};

type ExecutionResult = { type: 'completed' } | { type: 'rescheduled' };

type RunningQueue = {
  type: 'running';
  workerUtils: WorkerUtils;
  runner: Runner;
};

type QueueState =
  | { type: 'idle' }
  | { type: 'starting'; promise: Promise<void> }
  | RunningQueue
  | { type: 'closed' };

const RegisteredHandlers = Symbol.for(
  '@workflow/world-postgres/registered-handlers'
);
const globalQueueState = globalThis as typeof globalThis & {
  [RegisteredHandlers]?: Map<QueuePrefix, QueueHandler[]>;
};
if (!globalQueueState[RegisteredHandlers]) {
  globalQueueState[RegisteredHandlers] = new Map();
}
const registeredHandlers = globalQueueState[RegisteredHandlers];

function createGraphileLogger() {
  return new Logger(() => (level: string, message: string, meta?: unknown) => {
    if (process.env.WORKFLOW_JSON_MODE === '1') return;
    if (
      (level === 'debug' || level === 'info') &&
      process.env.DEBUG === undefined
    ) {
      return;
    }

    const pipe = level === 'error' ? process.stderr : process.stdout;
    pipe.write(
      meta
        ? `[Graphile Worker] ${message} ${JSON.stringify(meta, null, 2)}\n`
        : `[Graphile Worker] ${message}\n`
    );
  });
}

const graphileLogger = createGraphileLogger();

function getRegisteredHandler(prefix: QueuePrefix): QueueHandler | undefined {
  return registeredHandlers.get(prefix)?.at(-1);
}

function parseTransportValue(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString(), (_key, value) =>
    value !== null &&
    typeof value === 'object' &&
    value.__type === 'Uint8Array' &&
    typeof value.data === 'string'
      ? new Uint8Array(Buffer.from(value.data, 'base64'))
      : value
  );
}

/**
 * The Postgres queue stores workflow and step jobs in Graphile Worker. The
 * runner starts as soon as its database is ready. Each delivery uses a
 * registered in-process handler when one exists, or the explicit
 * WORKFLOW_LOCAL_BASE_URL fallback. When no executor is available, the job is
 * durably replaced with a short-delay job before the current job is acked.
 */
export type PostgresQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createQueue(
  config: PostgresWorldConfig,
  pool: Pool
): PostgresQueue {
  const transport: Transport<unknown> = {
    contentType: 'application/json',
    serialize(value: unknown): Buffer {
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
    },
    async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return parseTransportValue(Buffer.concat(chunks));
    },
  };

  const generateMessageId = monotonicFactory();
  const namespace = resolveQueueNamespace(config.namespace);
  const workflowPrefix = getQueueTopicPrefix('workflow', namespace);
  const stepPrefix = getQueueTopicPrefix('step', namespace);
  const queueConcurrency = QueueConcurrency.parse(
    config.queueConcurrency ?? 50
  );
  const ownedHandlers: { prefix: QueuePrefix; handler: QueueHandler }[] = [];
  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  const inflightWorkflowRuns = new Map<string, Promise<ExecutionResult>>();
  const healthyRemotePrefixes = new Set<QueuePrefix>();
  let state: QueueState = { type: 'idle' };

  function isClosed(): boolean {
    return state.type === 'closed';
  }

  function getJobQueueName(prefix: QueuePrefix): string {
    const jobPrefix = config.jobPrefix ?? 'workflow_';
    return getQueuePrefixKind(prefix) === 'workflow'
      ? `${jobPrefix}flows`
      : `${jobPrefix}steps`;
  }

  function getHealthUrl(baseUrl: string, prefix: QueuePrefix): string {
    const kind = getQueuePrefixKind(prefix);
    const url = new URL(
      createWorkflowUrl(baseUrl, {
        type: kind === 'workflow' ? 'health' : 'step',
      })
    );
    if (kind === 'step') url.search = '__health';
    return url.toString();
  }

  async function addGraphileJob(
    workerUtils: WorkerUtils,
    job: {
      prefix: QueuePrefix;
      message: MessageData;
      delaySeconds: number;
    }
  ): Promise<void> {
    const delaySeconds = TimeoutSeconds.parse(job.delaySeconds);
    await workerUtils.addJob(
      getJobQueueName(job.prefix),
      MessageData.encode(job.message),
      {
        jobKey: job.message.idempotencyKey ?? job.message.messageId,
        ...(delaySeconds > 0
          ? { runAt: new Date(Date.now() + delaySeconds * 1000) }
          : {}),
        maxAttempts: 3,
      }
    );
  }

  function markMessageCompleted(idempotencyKey: string): void {
    completedMessages.delete(idempotencyKey);
    completedMessages.add(idempotencyKey);
    if (completedMessages.size <= COMPLETED_IDEMPOTENCY_CACHE_LIMIT) return;

    const oldestKey = completedMessages.values().next().value;
    assert(oldestKey !== undefined);
    completedMessages.delete(oldestKey);
  }

  async function probeHealth(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      HEALTH_PROBE_TIMEOUT_MS
    );
    timeout.unref?.();
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveWorkflowBaseUrl(): Promise<string | undefined> {
    if (process.env.PORT) {
      return createWorkflowBaseUrl(`http://localhost:${process.env.PORT}`);
    }

    const port = await getWorkflowPort({
      endpoint: createWorkflowHealthEndpoint(),
    });
    return port === undefined
      ? undefined
      : createWorkflowBaseUrl(`http://localhost:${port}`);
  }

  async function resolveExecutor(prefix: QueuePrefix): Promise<QueueExecutor> {
    const handler = getRegisteredHandler(prefix);
    if (handler) return { type: 'direct', handler };

    const remoteBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    if (remoteBaseUrl) {
      if (
        !healthyRemotePrefixes.has(prefix) &&
        !(await probeHealth(getHealthUrl(remoteBaseUrl, prefix)))
      ) {
        return { type: 'unavailable' };
      }
      healthyRemotePrefixes.add(prefix);
      return { type: 'http', baseUrl: remoteBaseUrl };
    }

    const baseUrl = await resolveWorkflowBaseUrl();
    if (!baseUrl || !(await probeHealth(getHealthUrl(baseUrl, prefix)))) {
      return { type: 'unavailable' };
    }

    const registeredHandler = getRegisteredHandler(prefix);
    return registeredHandler
      ? { type: 'direct', handler: registeredHandler }
      : { type: 'http', baseUrl };
  }

  async function executeOverHttp(
    baseUrl: string,
    delivery: Delivery
  ): Promise<QueueHandlerResult> {
    const response = await fetch(
      createWorkflowUrl(baseUrl, {
        type:
          parseQueueName(delivery.queueName).kind === 'workflow'
            ? 'flow'
            : 'step',
      }),
      {
        method: 'POST',
        duplex: 'half',
        headers: {
          ...delivery.messageData.headers,
          'content-type': 'application/json',
          'x-vqs-queue-name': delivery.queueName,
          'x-vqs-message-id': delivery.messageData.messageId,
          'x-vqs-message-attempt': String(delivery.attempt),
        },
        body: delivery.messageData.data,
      } as RequestInit
    );

    if (!response.ok) {
      throw new Error(
        `Workflow queue HTTP execution failed with status ${response.status}: ${await response.text()}`
      );
    }

    const result = QueueHandlerHttpResponse.parse(await response.json());
    return 'timeoutSeconds' in result ? result : undefined;
  }

  async function executeDelivery(
    workerUtils: WorkerUtils,
    delivery: Delivery
  ): Promise<ExecutionResult> {
    const executor = await resolveExecutor(delivery.prefix);
    let result: QueueHandlerResult;

    switch (executor.type) {
      case 'unavailable':
        await addGraphileJob(workerUtils, {
          prefix: delivery.prefix,
          message: { ...delivery.messageData, attempt: delivery.attempt },
          delaySeconds: DEFERRED_EXECUTION_DELAY_SECONDS,
        });
        return { type: 'rescheduled' };
      case 'direct':
        result = await executor.handler(delivery.message, {
          attempt: delivery.attempt,
          queueName: delivery.queueName,
          messageId: delivery.messageData.messageId,
          requestId: delivery.messageData.headers?.['x-vercel-id'],
        });
        break;
      case 'http':
        result = await executeOverHttp(executor.baseUrl, delivery);
        break;
      default:
        return assertNever(executor);
    }

    if (result === undefined) return { type: 'completed' };

    await addGraphileJob(workerUtils, {
      prefix: delivery.prefix,
      message: {
        ...delivery.messageData,
        attempt: delivery.attempt + 1,
      },
      delaySeconds: TimeoutSeconds.parse(result.timeoutSeconds),
    });
    return { type: 'rescheduled' };
  }

  async function runSerializedWorkflowTask(
    serializationKey: string,
    execute: () => Promise<ExecutionResult>
  ): Promise<void> {
    const previous = inflightWorkflowRuns.get(serializationKey);
    const execution = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(execute)
      .finally(() => {
        if (inflightWorkflowRuns.get(serializationKey) === execution) {
          inflightWorkflowRuns.delete(serializationKey);
        }
      });
    inflightWorkflowRuns.set(serializationKey, execution);
    await execution;
  }

  async function runIdempotentTask(
    idempotencyKey: string,
    execute: () => Promise<ExecutionResult>
  ): Promise<void> {
    if (completedMessages.has(idempotencyKey)) return;

    const existing = inflightMessages.get(idempotencyKey);
    if (existing) {
      await existing;
      return;
    }

    const execution = execute()
      .then((result) => {
        switch (result.type) {
          case 'completed':
            markMessageCompleted(idempotencyKey);
            return;
          case 'rescheduled':
            return;
          default:
            return assertNever(result);
        }
      })
      .finally(() => {
        inflightMessages.delete(idempotencyKey);
      });
    inflightMessages.set(idempotencyKey, execution);
    await execution;
  }

  function createTaskHandler(
    prefix: QueuePrefix,
    workerUtils: WorkerUtils
  ): Task {
    const queueKind = getQueuePrefixKind(prefix);

    return async (payload: unknown, helpers: JobHelpers) => {
      const messageData = MessageData.parse(payload);
      const idempotencyKey = messageData.idempotencyKey;
      const message = QueuePayloadSchema.parse(
        parseTransportValue(messageData.data)
      );
      const delivery: Delivery = {
        prefix,
        queueName: ValidQueueName.parse(`${prefix}${messageData.id}`),
        messageData,
        message,
        attempt: messageData.attempt + helpers.job.attempts - 1,
      };
      const serializationKey =
        queueKind === 'workflow' && 'runId' in message
          ? `workflow:${message.runId}`
          : undefined;
      const execute = () => executeDelivery(workerUtils, delivery);

      if (idempotencyKey !== undefined) {
        await runIdempotentTask(idempotencyKey, execute);
        return;
      }
      if (serializationKey) {
        await runSerializedWorkflowTask(serializationKey, execute);
        return;
      }
      await execute();
    };
  }

  async function migratePgBossJobs(workerUtils: WorkerUtils): Promise<void> {
    type ExistsRow = { exists: boolean };
    type LegacyJob = {
      name: string;
      data: Record<string, unknown>;
      singleton_key: string | null;
      retry_limit: number | null;
    };

    const staging = await pool.query<ExistsRow>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'workflow'
        AND table_name = '_pgboss_pending_jobs'
      ) AS exists`
    );
    assert(staging.rows[0]);
    if (staging.rows[0].exists) {
      const jobs = await pool.query<LegacyJob>(
        `SELECT name, data, singleton_key, retry_limit
        FROM "workflow"."_pgboss_pending_jobs"`
      );
      for (const job of jobs.rows) {
        await workerUtils.addJob(job.name, job.data, {
          jobKey: job.singleton_key ?? undefined,
          maxAttempts: job.retry_limit ?? 3,
        });
      }
      await pool.query(`DROP TABLE "workflow"."_pgboss_pending_jobs"`);
      return;
    }

    const pgBoss = await pool.query<ExistsRow>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = 'pgboss'
      ) AS exists`
    );
    assert(pgBoss.rows[0]);
    if (!pgBoss.rows[0].exists) return;

    const jobs = await pool.query<LegacyJob>(
      `SELECT name, data, singleton_key, retry_limit
      FROM pgboss.job
      WHERE state IN ('created', 'retry')`
    );
    for (const job of jobs.rows) {
      await workerUtils.addJob(job.name, job.data, {
        jobKey: job.singleton_key ?? undefined,
        maxAttempts: job.retry_limit ?? 3,
      });
    }
    await pool.query(`DROP SCHEMA pgboss CASCADE`);
  }

  async function startQueue(): Promise<void> {
    let workerUtils: WorkerUtils | undefined;
    try {
      workerUtils = await makeWorkerUtils({
        pgPool: pool,
        logger: graphileLogger,
      });
      await workerUtils.migrate();
      await migratePgBossJobs(workerUtils);

      if (isClosed()) {
        await workerUtils.release();
        return;
      }

      const runner = await run({
        pgPool: pool,
        concurrency: queueConcurrency,
        logger: graphileLogger,
        pollInterval: 500,
        taskList: {
          [getJobQueueName(workflowPrefix)]: createTaskHandler(
            workflowPrefix,
            workerUtils
          ),
          [getJobQueueName(stepPrefix)]: createTaskHandler(
            stepPrefix,
            workerUtils
          ),
        },
      });

      if (isClosed()) {
        await runner.stop();
        await workerUtils.release();
        return;
      }

      state = { type: 'running', workerUtils, runner };
    } catch (error) {
      await workerUtils?.release();
      if (state.type !== 'closed') state = { type: 'idle' };
      throw error;
    }
  }

  async function start(): Promise<void> {
    switch (state.type) {
      case 'idle': {
        const promise = startQueue();
        state = { type: 'starting', promise };
        await promise;
        return;
      }
      case 'starting':
        await state.promise;
        return;
      case 'running':
        return;
      case 'closed':
        throw new Error('Postgres queue is closed');
      default:
        return assertNever(state);
    }
  }

  function getRunningQueue(): RunningQueue {
    if (state.type !== 'running') {
      throw new Error('Postgres queue is not running');
    }
    return state;
  }

  const queue: Queue['queue'] = async (queueName, message, options) => {
    await start();
    const { prefix, id } = parseQueueName(queueName);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await addGraphileJob(getRunningQueue().workerUtils, {
      prefix,
      message: {
        id,
        data: transport.serialize(message) as Buffer,
        attempt: 1,
        messageId,
        idempotencyKey: options?.idempotencyKey,
        headers: options?.headers,
      },
      delaySeconds: options?.delaySeconds ?? 0,
    });
    return { messageId };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    if (state.type === 'closed') {
      throw new Error('Postgres queue is closed');
    }

    const handlers = registeredHandlers.get(prefix) ?? [];
    handlers.push(handler);
    registeredHandlers.set(prefix, handlers);
    ownedHandlers.push({ prefix, handler });

    return async (request) => {
      const headers = QueueHandlerHeaders.safeParse(
        Object.fromEntries(request.headers)
      );
      if (!request.body || !headers.success) {
        return Response.json(
          { error: 'Invalid queue request' },
          { status: 400 }
        );
      }

      const queueName = headers.data['x-vqs-queue-name'];
      if (!queueName.startsWith(prefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      try {
        const result = await handler(
          await transport.deserialize(request.body),
          {
            attempt: headers.data['x-vqs-message-attempt'],
            queueName,
            messageId: headers.data['x-vqs-message-id'],
            requestId: request.headers.get('x-vercel-id') ?? undefined,
          }
        );
        return result === undefined
          ? Response.json({ ok: true })
          : Response.json({
              timeoutSeconds: TimeoutSeconds.parse(result.timeoutSeconds),
            });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  return {
    queueDeliveryMode: 'in-process',
    createQueueHandler,
    getDeploymentId: async () => 'postgres',
    queue,
    start,
    async close() {
      const previousState = state;
      if (previousState.type === 'closed') return;
      state = { type: 'closed' };

      switch (previousState.type) {
        case 'idle':
          break;
        case 'starting':
          await previousState.promise.catch(() => undefined);
          break;
        case 'running':
          await previousState.runner.stop();
          await previousState.workerUtils.release();
          break;
        default:
          assertNever(previousState);
      }

      healthyRemotePrefixes.clear();
      for (const { prefix, handler } of ownedHandlers) {
        const handlers = registeredHandlers.get(prefix);
        assert(handlers);
        const index = handlers.lastIndexOf(handler);
        assert(index !== -1);
        handlers.splice(index, 1);
        if (handlers.length === 0) registeredHandlers.delete(prefix);
      }
      ownedHandlers.length = 0;
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
