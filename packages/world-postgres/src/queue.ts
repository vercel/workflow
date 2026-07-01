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
// How long a job execution waits for a health probe to warm a lazy route
// module (which registers its direct handler) before durably deferring.
const REGISTRATION_WAIT_MS = 500;
const REGISTRATION_WAIT_POLL_MS = 25;
// Delay before a job with no available executor is redelivered.
const DEFERRED_EXECUTION_DELAY_SECONDS = 1;
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
  | { type: 'deferred' }
  | { type: 'reschedule'; timeoutSeconds: number };

type QueueExecutor =
  | { type: 'direct'; handler: QueueHandler }
  | { type: 'http'; baseUrl: string };

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
 * - `step` for step jobs
 *
 * When a message is queued, it is sent to graphile-worker with the appropriate
 * job type. The Graphile runner starts once an executor for the workflow queue
 * is available and registers both job types. Each job resolves its executor at
 * execution time: the registered in-process queue handler when one exists,
 * otherwise HTTP against `WORKFLOW_LOCAL_BASE_URL` when that route is healthy.
 * When neither is available yet (e.g. a lazily-loaded route module has not
 * registered its handler), the job triggers a health probe — which loads the
 * route module and lets it register — and is durably redelivered shortly
 * after. A job is only acknowledged after execution completes or a durable
 * follow-up job is scheduled.
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

  function getJobQueueName(queuePrefix: QueuePrefix): string {
    const jobPrefix = config.jobPrefix || 'workflow_';

    return getQueuePrefixKind(queuePrefix) === 'workflow'
      ? `${jobPrefix}flows`
      : `${jobPrefix}steps`;
  }

  function getHealthPath(queuePrefix: QueuePrefix): string {
    return getQueuePrefixKind(queuePrefix) === 'workflow'
      ? FLOW_HEALTH_PATH
      : STEP_HEALTH_PATH;
  }

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres';
  };

  const ownedHandlers: { prefix: QueuePrefix; handler: QueueHandler }[] = [];
  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  const inflightWorkflowRuns = new Map<string, Promise<QueueExecutionResult>>();
  // Remote health paths (against WORKFLOW_LOCAL_BASE_URL) that have responded
  // healthy at least once. Sticky: a route that later fails simply fails the
  // job, which graphile retries.
  const healthyRemotePaths = new Set<string>();
  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
  let startPromise: Promise<void> | null = null;
  let runnerPromise: Promise<void> | null = null;
  let bootstrapPromise: Promise<void> | null = null;
  let resolveRegistrationRetry: (() => void) | null = null;
  let closed = false;
  const requestRunnerStart = () => {
    resolveRegistrationRetry?.();
    void ensureRunner().catch(logStartRunnerError);
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
    handler,
    queueName,
    messageId,
    attempt,
    message,
    headers: extraHeaders,
  }: {
    handler: QueueHandler;
    queueName: ValidQueueName;
    messageId: MessageId;
    attempt: number;
    message: QueuePayload;
    headers?: Record<string, string>;
  }): Promise<QueueExecutionResult> {
    const result = await handler(message, {
      attempt,
      queueName,
      messageId,
      requestId: extraHeaders?.['x-vercel-id'],
    });

    return queueExecutionResult(result);
  }

  async function executeMessageOverHttp({
    baseUrl,
    queueName,
    messageId,
    attempt,
    body,
    headers: extraHeaders,
  }: {
    baseUrl: string;
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
      `${baseUrl}/.well-known/workflow/v1/${pathname}`,
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
      case 'deferred':
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

  /**
   * No executor is available for this job yet. Durably re-add it with a
   * short delay (before acking the current delivery) so it retries once
   * handler registration or remote route health catches up. The attempt
   * count is left unchanged since nothing was executed.
   */
  async function deferExecution(
    queuePrefix: QueuePrefix,
    messageData: MessageData
  ): Promise<QueueExecutionResult> {
    await addGraphileJob({
      queuePrefix,
      queueId: messageData.id,
      body: messageData.data,
      messageId: messageData.messageId,
      attempt: messageData.attempt,
      idempotencyKey: messageData.idempotencyKey,
      headers: messageData.headers,
      delaySeconds: DEFERRED_EXECUTION_DELAY_SECONDS,
      jobKey: messageData.idempotencyKey ?? messageData.messageId,
    });
    return { type: 'deferred' };
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
    await ensureRunner();
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    assertOpen();
    await startWorkerUtils();
    void ensureRunner().catch(logStartRunnerError);
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

  function hasRemoteQueueFallback() {
    return Boolean(process.env.WORKFLOW_LOCAL_BASE_URL);
  }

  /**
   * Whether a workflow-queue job dispatched right now could execute. Direct
   * handler registration always qualifies; the remote route only qualifies
   * once it has probed healthy, so the runner does not consume jobs that
   * would just fail against an unreachable server.
   */
  function hasWorkflowExecutor(): boolean {
    if (getRegisteredHandler(workflowPrefix)) return true;
    return hasRemoteQueueFallback() && healthyRemotePaths.has(FLOW_HEALTH_PATH);
  }

  /**
   * Resolve how to execute a job for the given queue prefix, at execution
   * time. Preferring the registered in-process handler on every job (rather
   * than snapshotting at runner startup) means late registrations and
   * unregistrations are picked up without restarting the Graphile runner.
   */
  async function resolveExecutor(
    queuePrefix: QueuePrefix
  ): Promise<QueueExecutor | undefined> {
    const handler = getRegisteredHandler(queuePrefix);
    if (handler) return { type: 'direct', handler };

    const healthPath = getHealthPath(queuePrefix);
    const fallbackBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    if (fallbackBaseUrl) {
      const baseUrl = normalizeBaseUrl(fallbackBaseUrl);
      if (
        healthyRemotePaths.has(healthPath) ||
        (await probeHealthPath(baseUrl, healthPath))
      ) {
        healthyRemotePaths.add(healthPath);
        return { type: 'http', baseUrl };
      }
      return undefined;
    }

    // Same-process bootstrap: the POST health probe loads a lazy route
    // module, whose module init registers the direct handler moments later.
    const baseUrl = await resolveWorkflowBaseUrl();
    if (baseUrl && (await probeHealthPath(baseUrl, healthPath))) {
      const lateHandler = await waitForRegisteredHandler(queuePrefix);
      if (lateHandler) return { type: 'direct', handler: lateHandler };
    }
    return undefined;
  }

  async function waitForRegisteredHandler(
    queuePrefix: QueuePrefix
  ): Promise<QueueHandler | undefined> {
    const deadline = Date.now() + REGISTRATION_WAIT_MS;
    while (!closed && Date.now() < deadline) {
      const handler = getRegisteredHandler(queuePrefix);
      if (handler) return handler;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, REGISTRATION_WAIT_POLL_MS);
        timeout.unref?.();
      });
    }
    return getRegisteredHandler(queuePrefix);
  }

  function createTaskHandler(queuePrefix: QueuePrefix) {
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
        const executor = await resolveExecutor(queuePrefix);
        if (!executor) {
          return deferExecution(queuePrefix, messageData);
        }

        const result =
          executor.type === 'direct'
            ? await executeMessageDirect({
                handler: executor.handler,
                queueName,
                messageId: messageData.messageId,
                attempt,
                message,
                headers: messageData.headers,
              })
            : await executeMessageOverHttp({
                baseUrl: executor.baseUrl,
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

  /**
   * Start the Graphile runner once a workflow executor is available. The
   * runner registers both job types up front and is never replaced; per-job
   * executor resolution absorbs all later registration changes. When no
   * workflow executor exists yet, kick the bootstrap loop that probes the
   * flow route until one appears.
   */
  function ensureRunner(): Promise<void> {
    if (closed || !workerUtils || runner) return Promise.resolve();
    if (!hasWorkflowExecutor()) {
      startBootstrapLoop();
      return Promise.resolve();
    }
    if (!runnerPromise) {
      runnerPromise = startRunnerNow().finally(() => {
        runnerPromise = null;
      });
    }
    return runnerPromise;
  }

  async function startRunnerNow(): Promise<void> {
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
      taskList: {
        [getJobQueueName(workflowPrefix)]: createTaskHandler(workflowPrefix),
        [getJobQueueName(stepPrefix)]: createTaskHandler(stepPrefix),
      },
    });
    if (closed) {
      await nextRunner.stop();
      return;
    }
    runner = nextRunner;
  }

  function startBootstrapLoop() {
    if (bootstrapPromise || closed) return;
    bootstrapPromise = (async () => {
      while (!closed && !hasWorkflowExecutor()) {
        await probeFlowRoute();
        if (closed || hasWorkflowExecutor()) break;
        await waitForRegistrationRetry();
      }
      await ensureRunner();
    })()
      .catch((err) => {
        process.stderr.write(
          `[Graphile Worker] Failed while waiting for workflow handler registration: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }\n`
        );
      })
      .finally(() => {
        bootstrapPromise = null;
      });
  }

  /**
   * Probe the flow health endpoint. A POST probe against a same-process
   * server loads the lazy route module, which registers its direct handler.
   * Against `WORKFLOW_LOCAL_BASE_URL`, a healthy response marks the remote
   * route usable for HTTP execution. The step route is not probed here —
   * step jobs probe it on demand in resolveExecutor.
   */
  async function probeFlowRoute(): Promise<void> {
    const baseUrl = await resolveWorkflowBaseUrl();
    if (!baseUrl) return;
    const flowHealthy = await probeHealthPath(baseUrl, FLOW_HEALTH_PATH);
    if (flowHealthy && hasRemoteQueueFallback()) {
      healthyRemotePaths.add(FLOW_HEALTH_PATH);
    }
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
      // The server may not be listening yet. The caller retries.
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/$/, '');
  }

  async function resolveWorkflowBaseUrl(): Promise<string | undefined> {
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
      return normalizeBaseUrl(process.env.WORKFLOW_LOCAL_BASE_URL);
    }
    if (process.env.PORT) {
      return `http://localhost:${process.env.PORT}`;
    }
    const port = await getWorkflowPort();
    return typeof port === 'number' ? `http://localhost:${port}` : undefined;
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
      await bootstrapPromise?.catch(() => {});
      await runnerPromise?.catch(() => {});
      if (runner) {
        await runner.stop();
        runner = null;
      }
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
      startPromise = null;
      healthyRemotePaths.clear();
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
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled queue execution result: ${JSON.stringify(value)}`);
}
