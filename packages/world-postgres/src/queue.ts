import type { Transport } from '@vercel/queue';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  getQueuePrefixKind,
  getQueueTopicPrefix,
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  type QueuePayload,
  QueuePayloadSchema,
  type QueuePrefix,
  resolveQueueNamespace,
  ValidQueueName,
} from '@workflow/world';
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
import { Mutex } from './util.js';

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
const REGISTRATION_RETRY_MS = 500;
const REGISTRATION_PROBE_TIMEOUT_MS = 500;
const FLOW_HEALTH_PATH = '/.well-known/workflow/v1/flow?__health';
const STEP_HEALTH_PATH = '/.well-known/workflow/v1/step?__health';
const GraphileHelpers = z.object({
  job: z.object({
    attempts: z.number().int().positive(),
  }),
});
const TimeoutSeconds = z.number().finite().nonnegative();
const QueueHandlerHttpResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ timeoutSeconds: TimeoutSeconds }).strict(),
]);

const HeaderParser = z.object({
  'x-vqs-queue-name': ValidQueueName,
  'x-vqs-message-id': MessageId,
  'x-vqs-message-attempt': z.coerce.number().int().positive(),
});

type QueueHandler = Parameters<Queue['createQueueHandler']>[1];
type QueueHandlerResult = Awaited<ReturnType<QueueHandler>>;
type QueueHandlerHttpResponse = z.infer<typeof QueueHandlerHttpResponseSchema>;

type QueueExecutionResult =
  | { type: 'completed' }
  | { type: 'reschedule'; timeoutSeconds: number };

type QueueTaskExecutor = { type: 'direct' } | { type: 'http'; baseUrl: string };
type QueueTask = {
  queuePrefix: QueuePrefix;
  executor: QueueTaskExecutor;
};
type RunnerTarget = {
  queueTasks: QueueTask[];
};
type HealthyWorkflowRoutes = {
  baseUrl: string;
  step: boolean;
};

const globalQueueState = globalThis as typeof globalThis & {
  __workflowPostgresQueueHandlers?: Map<QueuePrefix, QueueHandler[]>;
  __workflowPostgresQueueStarters?: Set<() => void>;
};
if (!globalQueueState.__workflowPostgresQueueHandlers) {
  globalQueueState.__workflowPostgresQueueHandlers = new Map();
}
if (!globalQueueState.__workflowPostgresQueueStarters) {
  globalQueueState.__workflowPostgresQueueStarters = new Set();
}
const registeredHandlers = globalQueueState.__workflowPostgresQueueHandlers;
const queueStarters = globalQueueState.__workflowPostgresQueueStarters;

function getRegisteredHandler(prefix: QueuePrefix): QueueHandler | undefined {
  const handlers = registeredHandlers.get(prefix);
  return handlers?.[handlers.length - 1];
}

function parseTransportValue(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString(), (_key, v) =>
    v !== null &&
    typeof v === 'object' &&
    v.__type === 'Uint8Array' &&
    typeof v.data === 'string'
      ? new Uint8Array(Buffer.from(v.data, 'base64'))
      : v
  );
}

/**
 * The Postgres queue works by creating two job types in graphile-worker:
 * - `workflow` for workflow jobs
 *   - `step` for step jobs
 *
 * When a message is queued, it is sent to graphile-worker with the appropriate job type.
 * When a job is processed, Graphile executes the registered workflow handler
 * directly in this process and only acknowledges the job after execution
 * completes or a durable delayed follow-up job is scheduled.
 */
export type PostgresQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createQueue(
  config: PostgresWorldConfig,
  pool: Pool
): PostgresQueue {
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
      return parseTransportValue(Buffer.concat(chunks));
    },
  };
  const generateMessageId = monotonicFactory();
  const namespace = resolveQueueNamespace(config.namespace);
  const workflowPrefix = getQueueTopicPrefix('workflow', namespace);
  const stepPrefix = getQueueTopicPrefix('step', namespace);
  const requiredQueuePrefixes = [workflowPrefix] as QueuePrefix[];
  const expectedQueuePrefixes = [workflowPrefix, stepPrefix] as QueuePrefix[];

  function getJobQueueName(queuePrefix: QueuePrefix): string {
    const jobPrefix = config.jobPrefix || 'workflow_';

    return getQueuePrefixKind(queuePrefix) === 'workflow'
      ? `${jobPrefix}flows`
      : `${jobPrefix}steps`;
  }

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres';
  };

  const ownedHandlers: { prefix: QueuePrefix; handler: QueueHandler }[] = [];
  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  const inflightWorkflowRuns = new Map<string, Promise<QueueExecutionResult>>();
  const startRunnerMutex = new Mutex();
  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
  let runningTarget: RunnerTarget | null = null;
  let remoteRoutes: HealthyWorkflowRoutes | null = null;
  let startPromise: Promise<void> | null = null;
  let runnerPromise: Promise<void> | null = null;
  let registrationPromise: Promise<void> | null = null;
  let resolveRegistrationRetry: (() => void) | null = null;
  let closed = false;
  const requestRunnerStart = () => {
    void startRunner().catch(logStartRunnerError);
  };
  queueStarters.add(requestRunnerStart);

  function logStartRunnerError(err: unknown) {
    process.stderr.write(
      `[Graphile Worker] Failed to start after handler registration: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }\n`
    );
  }

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
      getJobQueueName(queuePrefix),
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

  function queueExecutionResult(
    result: QueueHandlerResult | QueueHandlerHttpResponse
  ): QueueExecutionResult {
    if (result === undefined) {
      return { type: 'completed' };
    }
    if ('timeoutSeconds' in result) {
      return {
        type: 'reschedule',
        timeoutSeconds: TimeoutSeconds.parse(result.timeoutSeconds),
      };
    }
    return { type: 'completed' };
  }

  async function executeMessageDirect({
    queueName,
    messageId,
    attempt,
    message,
    headers: extraHeaders,
  }: {
    queueName: ValidQueueName;
    messageId: MessageId;
    attempt: number;
    message: QueuePayload;
    headers?: Record<string, string>;
  }): Promise<QueueExecutionResult> {
    const { prefix } = parseQueueName(queueName);
    const handler = getRegisteredHandler(prefix);
    if (!handler) {
      throw new Error(`No handler registered for queue prefix ${prefix}`);
    }

    const result = await handler(message, {
      attempt,
      queueName,
      messageId,
      requestId: extraHeaders?.['x-vercel-id'],
    });

    return queueExecutionResult(result);
  }

  async function executeMessageOverHttp({
    executor,
    queueName,
    messageId,
    attempt,
    body,
    headers: extraHeaders,
  }: {
    executor: Extract<QueueTaskExecutor, { type: 'http' }>;
    queueName: ValidQueueName;
    messageId: MessageId;
    attempt: number;
    body: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<QueueExecutionResult> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      'content-type': 'application/json',
      'x-vqs-queue-name': queueName,
      'x-vqs-message-id': messageId,
      'x-vqs-message-attempt': String(attempt),
    };
    const pathname =
      parseQueueName(queueName).kind === 'workflow' ? 'flow' : 'step';
    const response = await fetch(
      `${executor.baseUrl}/.well-known/workflow/v1/${pathname}`,
      {
        method: 'POST',
        duplex: 'half',
        headers,
        body,
      } as RequestInit
    );
    if (!response.ok) {
      throw new Error(
        `Workflow queue HTTP execution failed with status ${response.status}: ${await response.text()}`
      );
    }
    return queueExecutionResult(
      QueueHandlerHttpResponseSchema.parse(await response.json())
    );
  }

  function deserializeMessage(body: Uint8Array): QueuePayload {
    return QueuePayloadSchema.parse(parseTransportValue(body));
  }

  function getWorkflowRunSerializationKey(
    queueKind: QueueKind,
    message: QueuePayload
  ): string | undefined {
    if (queueKind !== 'workflow') return undefined;
    return 'runId' in message ? `workflow:${message.runId}` : undefined;
  }

  function getGraphileAttempt(helpers: unknown, fallback: number): number {
    const graphileAttempt = GraphileHelpers.safeParse(helpers);
    return graphileAttempt.success
      ? graphileAttempt.data.job.attempts
      : fallback;
  }

  function queueHandlerResponse(result: QueueHandlerResult): Response {
    if (typeof result?.timeoutSeconds === 'number') {
      return Response.json({
        timeoutSeconds: TimeoutSeconds.parse(result.timeoutSeconds),
      });
    }
    return Response.json({ ok: true });
  }

  function assertOpen() {
    if (closed) {
      throw new Error('Postgres queue is closed');
    }
  }

  function getExistingMessageExecution(idempotencyKey: string) {
    if (completedMessages.has(idempotencyKey)) return Promise.resolve();
    return inflightMessages.get(idempotencyKey);
  }

  async function finishExecutionResult({
    queuePrefix,
    messageData,
    attempt,
    result,
  }: {
    queuePrefix: QueuePrefix;
    messageData: MessageData;
    attempt: number;
    result: QueueExecutionResult;
  }): Promise<QueueExecutionResult> {
    switch (result.type) {
      case 'completed':
        return result;
      case 'reschedule':
        // Schedule the follow-up job before we return so a crash cannot
        // lose the wake-up request.
        await addGraphileJob({
          queuePrefix,
          queueId: messageData.id,
          body: messageData.data,
          messageId: messageData.messageId,
          attempt: attempt + 1,
          idempotencyKey: messageData.idempotencyKey,
          headers: messageData.headers,
          delaySeconds: result.timeoutSeconds,
          jobKey: messageData.idempotencyKey ?? messageData.messageId,
        });
        return result;
      default:
        return assertNever(result);
    }
  }

  async function runSerializedWorkflowTask(
    serializationKey: string,
    executeTask: () => Promise<QueueExecutionResult>
  ) {
    const previous = inflightWorkflowRuns.get(serializationKey);
    const execution = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => executeTask())
      .finally(() => {
        if (inflightWorkflowRuns.get(serializationKey) === execution) {
          inflightWorkflowRuns.delete(serializationKey);
        }
      });
    inflightWorkflowRuns.set(serializationKey, execution);
    await execution;
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

  async function startWorkerUtils(): Promise<void> {
    assertOpen();
    if (!startPromise) {
      startPromise = (async () => {
        let utils: WorkerUtils | null = null;
        try {
          utils = await makeWorkerUtils({
            pgPool: pool,
            logger: graphileLogger,
          });
          await utils.migrate();
          await migratePgBossJobs(utils);
          workerUtils = utils;
        } catch (err) {
          startPromise = null;
          workerUtils = null;
          await utils?.release();
          throw err;
        }
      })();
    }
    await startPromise;
  }

  async function start(): Promise<void> {
    assertOpen();
    await startWorkerUtils();
    await startRunner();
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    assertOpen();
    await startWorkerUtils();
    if (!runner && !runnerPromise) {
      await startRunner();
    }
    const { prefix: queuePrefix, id: queueId } = parseQueueName(queue);
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

  function createTaskHandler({ queuePrefix, executor }: QueueTask) {
    const queueKind = getQueuePrefixKind(queuePrefix);

    return async (payload: unknown, helpers: unknown) => {
      const messageData = MessageData.parse(payload);
      const idempotencyKey = messageData.idempotencyKey;
      if (idempotencyKey) {
        const existing = getExistingMessageExecution(idempotencyKey);
        if (existing) {
          await existing;
          return;
        }
      }

      const attempt = getGraphileAttempt(helpers, messageData.attempt);
      const queueName = `${queuePrefix}${messageData.id}` as ValidQueueName;
      const message = deserializeMessage(messageData.data);
      const workflowRunSerializationKey = getWorkflowRunSerializationKey(
        queueKind,
        message
      );
      const executeTask = async (): Promise<QueueExecutionResult> => {
        const result =
          executor.type === 'direct'
            ? await executeMessageDirect({
                queueName,
                messageId: messageData.messageId,
                attempt,
                message,
                headers: messageData.headers,
              })
            : await executeMessageOverHttp({
                executor,
                queueName,
                messageId: messageData.messageId,
                attempt,
                body: messageData.data,
                headers: messageData.headers,
              });

        return finishExecutionResult({
          queuePrefix,
          messageData,
          attempt,
          result,
        });
      };

      if (!idempotencyKey) {
        if (workflowRunSerializationKey) {
          await runSerializedWorkflowTask(
            workflowRunSerializationKey,
            executeTask
          );
          return;
        }

        await executeTask();
        return;
      }

      const execution = Promise.resolve()
        .then(executeTask)
        .then((result) => {
          if (result.type === 'completed') {
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

  async function startRunner(): Promise<void> {
    await startRunnerMutex.andThen(startRunnerOnce);
  }

  async function startRunnerOnce(): Promise<void> {
    if (closed || !workerUtils) return;
    if (runnerPromise) {
      await runnerPromise;
      if (closed) return;
    }

    if (needsHandlerRegistration()) startRegistrationLoop();
    const target = getRunnerTarget();
    if (!target) {
      await stopRunner();
      return;
    }
    if (runner && hasRunningTarget(target)) return;
    runnerPromise = replaceRunner(target).finally(() => {
      runnerPromise = null;
    });
    await runnerPromise;
  }

  async function replaceRunner(target: RunnerTarget) {
    await stopRunner();
    await setupListeners(target);
  }

  async function stopRunner() {
    if (!runner) return;
    await runner.stop();
    runner = null;
    runningTarget = null;
  }

  function hasRunningTarget({ queueTasks }: RunnerTarget) {
    const activeTarget = runningTarget;
    if (!activeTarget) return false;
    return (
      activeTarget.queueTasks.length === queueTasks.length &&
      queueTasks.every((task, index) =>
        sameQueueTask(task, activeTarget.queueTasks[index])
      )
    );
  }

  function sameQueueTask(task: QueueTask, other: QueueTask | undefined) {
    if (!other || task.queuePrefix !== other.queuePrefix) return false;
    if (task.executor.type !== other.executor.type) return false;
    switch (task.executor.type) {
      case 'direct':
        return true;
      case 'http':
        return (
          other.executor.type === 'http' &&
          task.executor.baseUrl === other.executor.baseUrl
        );
      default:
        return assertNever(task.executor);
    }
  }

  function startRegistrationLoop() {
    if (registrationPromise) return;
    registrationPromise = waitForHandlerRegistration()
      .catch((err) => {
        process.stderr.write(
          `[Graphile Worker] Failed while waiting for workflow handler registration: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }\n`
        );
      })
      .finally(() => {
        registrationPromise = null;
      });
  }

  async function waitForHandlerRegistration() {
    while (!closed && needsHandlerRegistration()) {
      const healthyRoutes = await probeNextWorkflowRoutes();
      if (closed || !needsHandlerRegistration()) break;
      if (!healthyRoutes || !hasRemoteQueueFallback()) {
        await waitForRegistrationRetry();
        continue;
      }

      remoteRoutes = healthyRoutes;
      if (healthyRoutes.step) {
        break;
      }
      await startRunner();
      await waitForRegistrationRetry();
    }
    await startRunner();
  }

  async function probeNextWorkflowRoutes(): Promise<
    HealthyWorkflowRoutes | undefined
  > {
    if (!remoteRoutes || !hasRemoteQueueFallback()) {
      return probeWorkflowRoutes();
    }
    return {
      ...remoteRoutes,
      step: await probeHealthPath(remoteRoutes.baseUrl, STEP_HEALTH_PATH),
    };
  }

  function hasRemoteQueueFallback() {
    return Boolean(process.env.WORKFLOW_LOCAL_BASE_URL);
  }

  function needsHandlerRegistration() {
    const target = getRunnerTarget();
    return (
      !target ||
      (hasRemoteQueueFallback() &&
        target.queueTasks.length < expectedQueuePrefixes.length)
    );
  }

  async function waitForRegistrationRetry() {
    await new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timeout);
        if (resolveRegistrationRetry === wake) {
          resolveRegistrationRetry = null;
        }
        resolve();
      };
      resolveRegistrationRetry = wake;
      timeout = setTimeout(wake, REGISTRATION_RETRY_MS);
      timeout.unref?.();
    });
  }

  async function probeWorkflowRoutes(): Promise<
    HealthyWorkflowRoutes | undefined
  > {
    const baseUrl = await resolveWorkflowBaseUrl();
    if (!baseUrl) return undefined;
    if (!(await probeHealthPath(baseUrl, FLOW_HEALTH_PATH))) return undefined;
    return {
      baseUrl,
      step: await probeHealthPath(baseUrl, STEP_HEALTH_PATH),
    };
  }

  async function probeHealthPath(
    baseUrl: string,
    path: string
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REGISTRATION_PROBE_TIMEOUT_MS
    );
    timeout.unref?.();
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      // The server may not be listening yet. The registration loop retries.
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveWorkflowBaseUrl(): Promise<string | undefined> {
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
      return process.env.WORKFLOW_LOCAL_BASE_URL.replace(/\/$/, '');
    }
    if (process.env.PORT) {
      return `http://localhost:${process.env.PORT}`;
    }
    const port = await getWorkflowPort();
    return typeof port === 'number' ? `http://localhost:${port}` : undefined;
  }

  function getRunnerTarget(): RunnerTarget | undefined {
    const queueTasks: RunnerTarget['queueTasks'] = [];

    for (const queuePrefix of expectedQueuePrefixes) {
      if (getRegisteredHandler(queuePrefix)) {
        queueTasks.push({ queuePrefix, executor: { type: 'direct' } });
        continue;
      }

      if (
        remoteRoutes &&
        (queuePrefix === workflowPrefix || remoteRoutes.step)
      ) {
        queueTasks.push({
          queuePrefix,
          executor: { type: 'http', baseUrl: remoteRoutes.baseUrl },
        });
      }
    }

    return requiredQueuePrefixes.every((prefix) =>
      queueTasks.some((task) => task.queuePrefix === prefix)
    )
      ? { queueTasks }
      : undefined;
  }

  async function setupListeners({ queueTasks }: RunnerTarget) {
    const taskList: Record<
      string,
      (payload: unknown, helpers: unknown) => Promise<void>
    > = {};
    for (const task of queueTasks) {
      taskList[getJobQueueName(task.queuePrefix)] = createTaskHandler(task);
    }

    const nextRunner = await run({
      pgPool: pool,
      // Default of 50 is high enough to avoid worker-pool exhaustion in
      // workflows that use parent→child polling patterns (e.g. awaiting a
      // child workflow via `childRun.returnValue` inside the parent).
      // Every such poll holds a worker slot for the duration of the child
      // run. Recursive workflows like `fibonacciWorkflow` fan out quickly
      // — fib(6) produces ~24 concurrent polling steps at peak, and at
      // concurrency=10 (the previous default) it would deadlock on the
      // default Postgres setup. See packages/core/src/runtime/run.ts and
      // docs/content/docs/changelog/eager-processing.mdx for context.
      concurrency: config.queueConcurrency || 50,
      logger: graphileLogger,
      pollInterval: 500, // 500ms = 0.5s (graphile-worker uses LISTEN/NOTIFY when available)
      taskList,
    });
    if (closed) {
      await nextRunner.stop();
      return;
    }
    runner = nextRunner;
    runningTarget = { queueTasks };
  }

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    assertOpen();
    const handlers = registeredHandlers.get(prefix) ?? [];
    handlers.push(handler);
    registeredHandlers.set(prefix, handlers);
    ownedHandlers.push({ prefix, handler });
    for (const startQueue of queueStarters) {
      startQueue();
    }

    return async (req) => {
      if (!req.body) {
        return Response.json(
          { error: 'Missing request body' },
          { status: 400 }
        );
      }

      const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));
      if (!headers.success) {
        return Response.json(
          { error: 'Missing required headers' },
          { status: 400 }
        );
      }

      const queueName = headers.data['x-vqs-queue-name'];
      if (!queueName.startsWith(prefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      try {
        const message = await transport.deserialize(req.body);
        const result = await handler(message, {
          attempt: headers.data['x-vqs-message-attempt'],
          queueName,
          messageId: headers.data['x-vqs-message-id'],
          requestId: req.headers.get('x-vercel-id') ?? undefined,
        });

        return queueHandlerResponse(result);
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    start,
    async close() {
      closed = true;
      queueStarters.delete(requestRunnerStart);
      resolveRegistrationRetry?.();
      await startPromise?.catch(() => {});
      await registrationPromise?.catch(() => {});
      await startRunnerMutex.promise.catch(() => {});
      await runnerPromise?.catch(() => {});
      await stopRunner();
      runningTarget = null;
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
      startPromise = null;
      runnerPromise = null;
      remoteRoutes = null;
      for (const { prefix, handler } of ownedHandlers) {
        const handlers = registeredHandlers.get(prefix);
        if (!handlers) continue;
        const index = handlers.lastIndexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
        if (handlers.length === 0) {
          registeredHandlers.delete(prefix);
        }
      }
      ownedHandlers.length = 0;
      for (const startQueue of queueStarters) {
        startQueue();
      }
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled queue execution result: ${JSON.stringify(value)}`);
}
