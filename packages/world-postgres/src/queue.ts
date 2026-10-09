import { connect } from 'node:net';
import * as Stream from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Transport } from '@vercel/queue';
import { WorkflowWorldError } from '@workflow/errors';
import {
  captureInvocationOutcome,
  isTerminalInvocationError,
} from '@workflow/errors/invocation';
import {
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
  createWorkflowUrl,
} from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  MessageId,
  parseQueueName,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  resolveQueueNamespace,
  type ValidQueueName,
  WorkflowInvokePayloadSchema,
} from '@workflow/world';
import {
  createNodeHttpAgents,
  destroyNodeHttpAgents,
  nodeHttpFetch,
} from '@workflow/world/node-http.js';
import { createWorld } from '@workflow/world-local';
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
import type { LostWorker, PostgresWorldConfig } from './config.js';
import { executeWithInputs } from './executor.js';
import { createInvocations } from './invocations.js';
import { MessageData } from './message.js';

/**
 * Serialize Graphile Worker log metadata. `JSON.stringify` alone renders an
 * `Error` as `{}` because `name`, `message`, `stack`, and `cause` are
 * non-enumerable, which is how a failed delivery used to log `"error": {}`.
 * Errors are expanded to those fields plus their enumerable properties (such as
 * a transport `code`), recursively through `cause` and `AggregateError.errors`.
 * An error that has already been expanded is replaced with a marker: a cyclic
 * cause chain would otherwise make `JSON.stringify` throw from inside the
 * logger, and Graphile has no fallback for a logger that throws.
 */
export function serializeGraphileMeta(meta: unknown): string {
  const seen = new WeakSet<object>();
  const expandError = (error: Error): Record<string, unknown> => {
    if (seen.has(error)) {
      return { name: error.name, message: error.message, repeated: true };
    }
    seen.add(error);
    const expanded: Record<string, unknown> = {
      ...error,
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined) expanded.cause = error.cause;
    if (error instanceof AggregateError) expanded.errors = error.errors;
    return expanded;
  };
  return JSON.stringify(
    meta,
    (_key, value) => (value instanceof Error ? expandError(value) : value),
    2
  );
}

function createGraphileLogger() {
  const isJsonMode = () => process.env.WORKFLOW_JSON_MODE === '1';
  const isVerbose = () => Boolean(process.env.DEBUG);

  return new Logger(() => (level: string, message: string, meta?: unknown) => {
    if (isJsonMode()) return;
    if ((level === 'debug' || level === 'info') && !isVerbose()) return;
    const pipe = level === 'error' ? process.stderr : process.stdout;
    if (meta) {
      pipe.write(
        `[Graphile Worker] ${message} ${serializeGraphileMeta(meta)}\n`
      );
    } else {
      pipe.write(`[Graphile Worker] ${message}\n`);
    }
  });
}

const graphileLogger = createGraphileLogger();

/**
 * Default deadlines for a queue delivery's response: none. A delivery executes
 * the workflow body inline, so response headers arrive only once that work is
 * done, and a bound here declares a slow-but-healthy delivery crashed and
 * redelivers it while the original is still running (two executions of the
 * same steps). Crash recovery is covered by Graphile releasing the job when
 * the worker dies, plus `reenqueueActiveRuns` on start.
 */
export const DEFAULT_DELIVERY_HEADERS_TIMEOUT_MS = 0;
export const DEFAULT_DELIVERY_BODY_TIMEOUT_MS = 0;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Per-request deadlines for the loopback delivery request. `0` disables the
 * deadline. An operator who prefers a hung handler to be redelivered rather
 * than hold its worker slot until restart sets these to a value above the
 * longest inline step they expect.
 */
export function getDeliveryTimeouts() {
  return {
    headersTimeoutMs: envTimeoutMs(
      'WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS',
      DEFAULT_DELIVERY_HEADERS_TIMEOUT_MS
    ),
    bodyTimeoutMs: envTimeoutMs(
      'WORKFLOW_POSTGRES_BODY_TIMEOUT_MS',
      DEFAULT_DELIVERY_BODY_TIMEOUT_MS
    ),
  };
}
const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;
// Core records MAX_DELIVERIES_EXCEEDED on delivery 49 (MAX_QUEUE_DELIVERIES +
// 1). Past that delivery, core only retries its terminal write, and it throws
// on a transient failure (429 / 5xx / transport) so the queue redelivers
// rather than acking and leaving the run `running`. Those redeliveries need
// attempts left on the job: with a cap of exactly 49, the first post-ceiling
// throw would retire the job and strand the run anyway. Graphile's retry
// backoff is exp(min(attempts, 10)) seconds, so each extra attempt waits ~6h
// and 24 of them keep retrying the terminal write for ~6 days.
// Mirrors `MAX_QUEUE_DELIVERIES + 1` in @workflow/core (runtime/constants.ts),
// which this package does not depend on. Keep the two in sync.
const CORE_MAX_DELIVERIES_EXCEEDED_ATTEMPT = 49;
const POST_CEILING_RETRY_ATTEMPTS = 24;
const MAX_GRAPHILE_JOB_ATTEMPTS =
  CORE_MAX_DELIVERIES_EXCEEDED_ATTEMPT + POST_CEILING_RETRY_ATTEMPTS;
const EXECUTOR_JOB_HEADER = 'x-workflow-postgres-executor-job';
const EXECUTOR_WORKER_HEADER = 'x-workflow-postgres-executor-worker';
const EXECUTOR_ATTEMPT_HEADER = 'x-workflow-postgres-executor-attempt';
const ExecutorDelivery = z.object({
  id: z.string().regex(/^\d+$/),
  worker: z.string().min(1),
  attempt: z.coerce.number().int().positive(),
});
type ExecutorDelivery = z.infer<typeof ExecutorDelivery>;

const GraphileHelpers = z.compile(
  z.object({
    abortSignal: z.instanceof(AbortSignal).optional(),
    job: z.object({
      attempts: z.number().int().positive(),
      id: z.string().optional(),
      locked_by: z.string().nullable().optional(),
      task_identifier: z.string().optional(),
      max_attempts: z.number().int().positive().optional(),
    }),
    getQueueName: z
      .custom<() => string | null | Promise<string | null>>(
        (value) => typeof value === 'function'
      )
      .optional(),
  })
);

type HttpExecutionResult =
  | { type: 'completed' }
  | { type: 'reschedule'; timeoutSeconds: number }
  | {
      type: 'error';
      status: number;
      text: string;
      headers: Record<string, string>;
    };

type RunnerStart = { controller: AbortController; promise: Promise<void> };
type LoopbackTarget = { hosts: string[]; port: number };

/**
 * Backoff for starting a runner in place of one the queue lost: 1s, doubling
 * with each failed start, capped at 30s. Replacing runners that keep being
 * lost soon after they start takes the same steps (see quickLossesBefore).
 */
const RUNNER_REPLACEMENT_RETRY_BASE_MS = 1_000;
const RUNNER_REPLACEMENT_RETRY_MAX_MS = 30_000;
/** A replacement lost sooner than this after it started was lost quickly. */
const QUICK_LOSS_WINDOW_MS = 30_000;
/**
 * How long a stopping runner's jobs run before their signals abort, passed to
 * Graphile Worker as `gracefulShutdownAbortTimeout` (its default). A retired
 * runner's deliveries get the same grace once close() stops the active runner,
 * or once a newer runner is retired.
 */
const SHUTDOWN_ABORT_TIMEOUT_MS = 5_000;

/** Step `step` (from 0) of the replacement backoff. */
function replacementBackoffMs(step: number) {
  return Math.min(
    RUNNER_REPLACEMENT_RETRY_MAX_MS,
    RUNNER_REPLACEMENT_RETRY_BASE_MS * 2 ** step
  );
}

/** A runner's deliveries, as its task handlers see them. */
type RunnerDeliveries = {
  /**
   * Set once the queue retires the runner, because a replacement took its
   * place or because it started when it was no longer needed. Its deliveries
   * do not see Graphile Worker's abort (see `withDeliverySignal`).
   */
  retiring: boolean;
  /**
   * Set once the queue aborts a retired runner's deliveries; one the runner
   * starts after that is aborted at once.
   */
  aborted: boolean;
  /** Aborts a retired runner's deliveries once their grace period passes. */
  graceTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Set<AbortController>;
};

/** What the queue tracks for each runner it starts. */
type RunnerState = RunnerDeliveries & {
  runner: Runner;
  /** Set once the runner is stopping, whoever stopped it. */
  stopping: boolean;
  /**
   * Set once Graphile Worker stopped the runner over an error and rejected its
   * promise. Such a runner is replaced like one that lost a worker.
   */
  failed: boolean;
  /** Set while a replacement of this runner is under way. */
  replacing: boolean;
  /** When the runner started, as `performance.now()`. */
  startedAt: number;
  /**
   * For a runner started in place of another, how many runners in a row
   * before it were lost soon after starting (see quickLossesBefore). Null for
   * the runner `start()` starts.
   */
  quickLosses: number | null;
};

/**
 * Releases that keep failing while fetches succeed (a misconfigured database,
 * or connections split between a primary and a read-only node) would have
 * every new runner lose its workers as fast as they finish jobs, each one
 * stranding its job. Replacing each runner at once would start runners at
 * that pace. So this counts the runners in a row, `lost` included, that were
 * started in place of another and lost within QUICK_LOSS_WINDOW_MS of
 * starting. Each is replaced only after the next backoff step, so such a
 * database costs at most one runner every RUNNER_REPLACEMENT_RETRY_MAX_MS.
 */
function quickLossesBefore(lost: RunnerState, now: number) {
  if (lost.quickLosses === null) return 0;
  return now - lost.startedAt < QUICK_LOSS_WINDOW_MS ? lost.quickLosses + 1 : 0;
}

/** Wait `ms`, or until `signal` aborts. */
function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

/** The default `onWorkerLost`. */
function warnLostWorker({ error, workerId, jobId }: LostWorker) {
  console.warn(
    `[world-postgres] Graphile Worker ended worker ${workerId}: releasing job ${jobId ?? '(unknown)'} failed:`,
    error
  );
}

function executorInput(message: unknown) {
  if (HealthCheckPayloadSchema.safeParse(message).success) return undefined;
  const parsed = WorkflowInvokePayloadSchema.safeParse(message);
  return parsed.success && !parsed.data.stepId ? parsed.data : undefined;
}

/**
 * Process workflow and step jobs, with optional run-scoped execution queues for invoke().
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
  const localWorld = createWorld({ dataDir: undefined, port });
  // Deliveries go over Node's core HTTP client rather than the global `fetch`:
  // undici's default 300s headers/body deadlines cannot be lifted without a
  // custom dispatcher, and a queue-owned pool keeps these sockets out of the
  // process-global agent. Concurrency is bounded by the Graphile runner, so
  // the pool itself does not need a socket cap.
  const httpAgents = createNodeHttpAgents({
    maxSockets: Infinity,
    keepAliveMs: 30_000,
  });
  const deliveryTimeouts = getDeliveryTimeouts();

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

  function getJobQueueName(): string {
    const jobPrefix = config.jobPrefix || 'workflow_';
    return `${jobPrefix}flows`;
  }

  const invocations = config.enableInvoke ? createInvocations(pool) : undefined;
  const executorQueueName = (runId: string) =>
    `${getJobQueueName()}:${runId}:executor`;
  const executorTask = () => `${getJobQueueName()}_executor`;

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    if (!invocations) return localWorld.createQueueHandler(prefix, handler);
    return async (req) => {
      // Keep transport provenance request-scoped; it is not a World API field.
      const delivery = ExecutorDelivery.safeParse({
        id: req.headers.get(EXECUTOR_JOB_HEADER),
        worker: req.headers.get(EXECUTOR_WORKER_HEADER),
        attempt: req.headers.get(EXECUTOR_ATTEMPT_HEADER),
      });
      const hasDelivery = [
        EXECUTOR_JOB_HEADER,
        EXECUTOR_WORKER_HEADER,
        EXECUTOR_ATTEMPT_HEADER,
      ].some((header) => req.headers.has(header));
      return localWorld.createQueueHandler(
        prefix,
        async (message, metadata) => {
          const input = executorInput(message);
          if (!input) {
            return handler(message, metadata);
          }
          if (!hasDelivery) {
            // Old workers can still POST ordinary orchestrator deliveries. Move
            // those to the serialized lane before acknowledging, never run them here.
            await transferToExecutor(
              {
                id: parseQueueName(metadata.queueName).id,
                data: transport.serialize(message) as Buffer,
                messageId: metadata.messageId,
                attempt: metadata.attempt,
              },
              input.runId,
              metadata.attempt
            );
            return;
          }
          if (!delivery.success)
            throw new WorkflowWorldError('Invalid executor delivery metadata', {
              status: 400,
            });
          const proof = delivery.data;
          // Use Graphile's public jobs view, not private tables. This verifies the
          // actual active task/queue/attempt rather than trusting a boolean header.
          // It is an admission check, NOT a fence on later journal writes.
          const { rows } = await pool.query(
            `SELECT id FROM graphile_worker.jobs
         WHERE id = $1 AND task_identifier = $2 AND queue_name = $3
           AND locked_by = $4 AND attempts = $5 AND locked_at IS NOT NULL`,
            [
              proof.id,
              executorTask(),
              executorQueueName(input.runId),
              proof.worker,
              proof.attempt,
            ]
          );
          if (rows.length === 0)
            throw new WorkflowWorldError(
              'Executor delivery is not active on the run queue',
              { status: 409 }
            );
          if (input.invoke) {
            if (!input.requestId)
              throw new WorkflowWorldError('Invocation requestId is required', {
                status: 400,
              });
            const outcome = await captureInvocationOutcome(
              () => handler(message, metadata),
              isTerminalInvocationError
            );
            await invocations.respondOutcome(
              input.runId,
              input.requestId,
              outcome
            );
            return;
          }
          const initial = await invocations.pending(input.runId);
          // A responded input may have committed just before the previous executor
          // died. Always drive the run; an empty mailbox alone is not a no-op proof.
          const feed = invocations.feed(input.runId, initial);
          return executeWithInputs(
            feed,
            () => handler(message, metadata),
            async (pending) => {
              const outcome = await captureInvocationOutcome(
                () =>
                  handler(
                    {
                      runId: input.runId,
                      invoke: true,
                      requestId: pending.id,
                      input: pending.payload,
                    },
                    metadata
                  ),
                isTerminalInvocationError
              );
              await invocations.respondOutcome(
                input.runId,
                pending.id,
                outcome
              );
            }
          );
        }
      )(req);
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'postgres';
  };

  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, Promise<void>>();
  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
  let runnerStart: RunnerStart | null = null;
  let closing = false;
  let startPromise: Promise<void> | null = null;
  const onWorkerLost = config.onWorkerLost ?? warnLostWorker;
  /** Replacements under way; close() waits for them. */
  const replacements = new Set<Promise<void>>();
  /**
   * Runners the queue retired, each until its stop settles: runners a
   * replacement took the place of, and runners that started when they were no
   * longer needed.
   */
  const retiredRunners = new Map<RunnerState, Promise<void>>();
  /** Wakes a replacement waiting to retry, once close() begins. */
  const closeController = new AbortController();
  /** Set once Graphile Worker's signal handling shuts the runners down. */
  let signalled = false;

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
    queueId,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
    jobKey,
    executorRunId,
    attemptOffset,
    maxAttempts = MAX_GRAPHILE_JOB_ATTEMPTS,
  }: {
    queueId: string;
    body: Buffer | Uint8Array;
    messageId: MessageId;
    attempt: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    delaySeconds?: number;
    jobKey?: string;
    executorRunId?: string;
    attemptOffset?: number;
    maxAttempts?: number;
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
      executorRunId ? executorTask() : getJobQueueName(),
      MessageData.encode({
        id: queueId,
        data: Buffer.from(body),
        attempt,
        ...(attemptOffset !== undefined ? { attemptOffset } : {}),
        messageId,
        idempotencyKey,
        headers,
      }),
      {
        ...(jobKey ? { jobKey } : {}),
        ...(runAt ? { runAt } : {}),
        maxAttempts,
        ...(executorRunId
          ? { queueName: executorQueueName(executorRunId) }
          : {}),
      }
    );
  }

  async function transferToExecutor(
    message: MessageData,
    runId: string,
    attempt: number,
    remainingAttempts = Math.max(1, MAX_GRAPHILE_JOB_ATTEMPTS - attempt + 1)
  ) {
    await start();
    await addGraphileJob({
      queueId: message.id,
      body: message.data,
      messageId: message.messageId,
      attempt,
      attemptOffset: attempt - 1,
      maxAttempts: remainingAttempts,
      idempotencyKey: message.idempotencyKey,
      headers: message.headers,
      // A distinct key avoids replacing the legacy job that is still locked.
      jobKey: `${executorTask()}:transfer:${message.messageId}`,
      executorRunId: runId,
    });
  }

  async function getExecutionBaseUrl(): Promise<string | undefined> {
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
      return process.env.WORKFLOW_LOCAL_BASE_URL;
    }

    if (typeof port === 'number') {
      return createWorkflowBaseUrl(`http://localhost:${port}`);
    }

    if (process.env.PORT) {
      return createWorkflowBaseUrl(`http://localhost:${process.env.PORT}`);
    }

    const detectedPort = await getWorkflowPort({
      endpoint: createWorkflowHealthEndpoint(),
    });
    if (typeof detectedPort === 'number') {
      return createWorkflowBaseUrl(`http://localhost:${detectedPort}`);
    }

    return undefined;
  }

  function getLoopbackHosts(hostname: string): string[] {
    if (hostname === 'localhost') {
      return ['127.0.0.1', '::1'];
    }
    if (hostname === '[::1]') {
      return ['::1'];
    }
    return hostname === '127.0.0.1' || hostname === '::1' ? [hostname] : [];
  }

  function getLoopbackTarget(baseUrl: string | undefined) {
    if (!baseUrl) {
      return undefined;
    }

    const url = new URL(baseUrl);
    const hosts = getLoopbackHosts(url.hostname);
    if (hosts.length === 0) {
      return undefined;
    }

    return {
      hosts,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    };
  }

  async function canConnectToLoopbackTarget(
    target: LoopbackTarget
  ): Promise<boolean> {
    for (const host of target.hosts) {
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = connect({ host, port: target.port });
        socket.unref();
        const finish = (isReachable: boolean) => {
          socket.destroy();
          resolve(isReachable);
        };

        socket.setTimeout(200, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      });

      if (reachable) {
        return true;
      }
    }

    return false;
  }

  async function startRunnerUnlessAborted(controller: AbortController) {
    if (controller.signal.aborted) {
      return;
    }

    await setupListeners();
  }

  async function waitForLoopbackAndStartRunner(
    controller: AbortController,
    target: LoopbackTarget
  ) {
    while (
      !controller.signal.aborted &&
      !(await canConnectToLoopbackTarget(target))
    ) {
      await sleep(50, undefined, {
        ref: false,
      });
    }

    await startRunnerUnlessAborted(controller);
  }

  function deferRunnerStart(
    controller: AbortController,
    target: LoopbackTarget
  ) {
    const promise = waitForLoopbackAndStartRunner(controller, target)
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.warn(
            '[world-postgres] Failed to start Graphile Worker after local workflow executor became reachable:',
            err
          );
        }
      })
      .finally(() => {
        if (runnerStart?.promise === promise) {
          runnerStart = null;
        }
      });
    runnerStart = { controller, promise };
  }

  async function executeMessageOverHttp({
    queueName,
    messageId,
    attempt,
    body,
    headers: extraHeaders,
    abortSignal,
    executorDelivery,
  }: {
    queueName: ValidQueueName;
    messageId: MessageId;
    attempt: number;
    body: Uint8Array;
    headers?: Record<string, string>;
    abortSignal?: AbortSignal;
    executorDelivery?: ExecutorDelivery;
  }): Promise<HttpExecutionResult> {
    const headers = new Headers(extraHeaders);
    headers.set('content-type', 'application/json');
    headers.set('x-vqs-queue-name', queueName);
    headers.set('x-vqs-message-id', messageId);
    headers.set('x-vqs-message-attempt', String(attempt));
    // Strip caller-supplied provenance case-insensitively. Only the verified
    // executor task may set these headers, including on retries.
    headers.delete(EXECUTOR_JOB_HEADER);
    headers.delete(EXECUTOR_WORKER_HEADER);
    headers.delete(EXECUTOR_ATTEMPT_HEADER);
    if (executorDelivery) {
      headers.set(EXECUTOR_JOB_HEADER, executorDelivery.id);
      headers.set(EXECUTOR_WORKER_HEADER, executorDelivery.worker);
      headers.set(EXECUTOR_ATTEMPT_HEADER, String(executorDelivery.attempt));
    }
    const baseUrl = await getExecutionBaseUrl();
    if (!baseUrl) {
      throw new Error('Unable to resolve base URL for workflow queue.');
    }
    // Queue shutdown aborts the delivery through Graphile's signal; the
    // deadlines are the operator's (see `getDeliveryTimeouts`).
    const response = await nodeHttpFetch(
      createWorkflowUrl(baseUrl, { type: 'flow' }),
      {
        method: 'POST',
        headers: new Headers(headers),
        body,
        signal: abortSignal,
        agents: httpAgents,
        ...deliveryTimeouts,
      }
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

  async function startRunnerWhenExecutorIsReady(): Promise<void> {
    if (closing || runner || runnerStart) {
      return;
    }

    const controller = new AbortController();
    const promise = (async () => {
      const target = getLoopbackTarget(await getExecutionBaseUrl());
      if (!target) {
        await startRunnerUnlessAborted(controller);
        return;
      }

      if (await canConnectToLoopbackTarget(target)) {
        await startRunnerUnlessAborted(controller);
        return;
      }

      if (controller.signal.aborted) {
        return;
      }

      deferRunnerStart(controller, target);
    })().finally(() => {
      if (runnerStart?.promise === promise) {
        runnerStart = null;
      }
    });
    runnerStart = { controller, promise };
    await promise;
  }

  async function start(): Promise<void> {
    if (closing) {
      return;
    }

    if (!startPromise) {
      startPromise = (async () => {
        try {
          workerUtils = await makeWorkerUtils({
            pgPool: pool,
            logger: graphileLogger,
          });
          await workerUtils.migrate();
          await migratePgBossJobs(workerUtils);
          await startRunnerWhenExecutorIsReady();
        } catch (err) {
          startPromise = null;
          throw err;
        }
      })();
    }
    await startPromise;
    if (!closing && !runner && !runnerStart) {
      await startRunnerWhenExecutorIsReady();
    }
  }

  const queue: Queue['queue'] = async (queue, message, opts) => {
    await start();
    const { id: queueId } = parseQueueName(queue);
    const body = transport.serialize(message) as Buffer;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const input = invocations ? executorInput(message) : undefined;
    await addGraphileJob({
      queueId,
      body,
      messageId,
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
      delaySeconds: opts?.delaySeconds,
      jobKey: opts?.idempotencyKey ?? messageId,
      ...(input ? { executorRunId: input.runId } : {}),
    });
    return { messageId };
  };

  const invoke: NonNullable<Queue['invoke']> = async (
    runId,
    payload,
    options
  ) => {
    if (!invocations) throw new Error('Postgres invoke is not enabled');
    await start();
    return invocations.invoke(
      runId,
      payload,
      options,
      async (client, _id, run) => {
        const wake = MessageData.encode({
          id: run.workflowName,
          data: transport.serialize({ runId }) as Buffer,
          messageId: MessageId.parse(`msg_${generateMessageId()}`),
          attempt: 1,
        });
        // The mailbox insertion and wake share this transaction. No job_key:
        // every invoke (including a completed request's retry) gets a wake.
        await client.query(
          `SELECT graphile_worker.add_job(identifier => $1, payload => $2::json,
          queue_name => $3, max_attempts => $4)`,
          [
            executorTask(),
            JSON.stringify(wake),
            executorQueueName(runId),
            MAX_GRAPHILE_JOB_ATTEMPTS,
          ]
        );
      }
    );
  };

  async function deserializeMessageBody(data: Buffer): Promise<unknown> {
    const bodyStream = Stream.Readable.toWeb(Stream.Readable.from([data]));
    return transport.deserialize(bodyStream as ReadableStream<Uint8Array>);
  }

  function createTaskHandler(
    deliveries: RunnerDeliveries,
    queue: QueuePrefix,
    executor = false
  ) {
    return async (payload: unknown, helpers: unknown) => {
      const messageData = MessageData.parse(payload);
      const graphileHelpers = GraphileHelpers.safeParse(helpers);
      const attempt = graphileHelpers.success
        ? graphileHelpers.data.job.attempts + (messageData.attemptOffset ?? 0)
        : messageData.attempt;
      const queueName = `${queue}${messageData.id}` as ValidQueueName;
      const body = await deserializeMessageBody(messageData.data);
      QueuePayloadSchema.parse(body);
      const orchestration = invocations ? executorInput(body) : undefined;
      let executorDelivery: ExecutorDelivery | undefined;
      if (orchestration) {
        const actualQueue =
          executor && graphileHelpers.success
            ? await graphileHelpers.data.getQueueName?.call(helpers)
            : undefined;
        if (
          !executor ||
          !graphileHelpers.success ||
          graphileHelpers.data.job.task_identifier !== executorTask() ||
          actualQueue !== executorQueueName(orchestration.runId)
        ) {
          const job = graphileHelpers.success
            ? graphileHelpers.data.job
            : undefined;
          await transferToExecutor(
            messageData,
            orchestration.runId,
            attempt,
            job
              ? Math.max(
                  1,
                  (job.max_attempts ?? MAX_GRAPHILE_JOB_ATTEMPTS) -
                    job.attempts +
                    1
                )
              : undefined
          );
          return;
        }
        executorDelivery = ExecutorDelivery.parse({
          id: graphileHelpers.data.job.id,
          worker: graphileHelpers.data.job.locked_by,
          attempt: graphileHelpers.data.job.attempts,
        });
      }
      const executeTask = async (): Promise<'completed' | 'rescheduled'> => {
        const result = await withDeliverySignal(
          deliveries,
          graphileHelpers.success
            ? graphileHelpers.data.abortSignal
            : undefined,
          (abortSignal) =>
            executeMessageOverHttp({
              queueName,
              messageId: messageData.messageId,
              attempt,
              body: messageData.data,
              headers: messageData.headers,
              executorDelivery,
              abortSignal,
            })
        );

        if (result.type === 'completed') {
          return 'completed';
        }

        if (result.type === 'reschedule') {
          // Schedule the follow-up job before we return so a crash cannot
          // lose the wake-up request.
          await addGraphileJob({
            queueId: messageData.id,
            body: messageData.data,
            messageId: messageData.messageId,
            attempt: attempt + 1,
            attemptOffset: messageData.attemptOffset,
            idempotencyKey: messageData.idempotencyKey,
            headers: messageData.headers,
            delaySeconds: result.timeoutSeconds,
            jobKey: messageData.idempotencyKey ?? messageData.messageId,
            ...(orchestration ? { executorRunId: orchestration.runId } : {}),
          });
          return 'rescheduled';
        }

        throw new Error(
          `[postgres world] Queue execution failed (${result.status}): ${result.text}`
        );
      };

      const idempotencyKey = messageData.idempotencyKey;
      if (!idempotencyKey) {
        // A delivery can hold an inline step until another wake aborts it.
        // Run-level exclusion here would also exclude that required wake.
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
    runner = (await createRunner(null)).runner;
  }

  async function createRunner(
    quickLosses: RunnerState['quickLosses']
  ): Promise<RunnerState> {
    const deliveries: RunnerDeliveries = {
      retiring: false,
      aborted: false,
      graceTimer: null,
      inFlight: new Set(),
    };
    const taskList: Record<
      string,
      (payload: unknown, helpers: unknown) => Promise<void>
    > = {};
    const namespace = resolveQueueNamespace(config.namespace);
    const workflowPrefix = getQueueTopicPrefix('workflow', namespace);
    taskList[getJobQueueName()] = createTaskHandler(deliveries, workflowPrefix);
    if (invocations)
      taskList[executorTask()] = createTaskHandler(
        deliveries,
        workflowPrefix,
        true
      );

    const created = await run({
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
      pollInterval: config.pollInterval ?? 500, // per worker; LISTEN/NOTIFY only wakes idle workers early
      gracefulShutdownAbortTimeout: SHUTDOWN_ABORT_TIMEOUT_MS,
      taskList,
    });
    const state: RunnerState = Object.assign(deliveries, {
      runner: created,
      stopping: false,
      failed: false,
      replacing: false,
      startedAt: performance.now(),
      quickLosses,
    });
    watchRunner(state);
    return state;
  }

  /**
   * Graphile Worker 0.16 ends a worker whose job release (completing or
   * failing the job) fails with an error it does not retry: a refused or reset
   * connection, a session the server ended, pg's own connect timeout, or a
   * retryable error that outlasted its 100 retries. It logs "committing
   * seppuku" and never replaces that worker, so each database failover a job
   * finishes across costs the runner a worker, and a runner that has lost them
   * all claims nothing while it still looks alive. Every loss is reported, and
   * the first on a runner that is not stopping starts its replacement.
   */
  function watchRunner(state: RunnerState) {
    const { events } = state.runner;
    const markStopping = () => {
      state.stopping = true;
    };
    events.on('stop', markStopping);
    events.on('pool:gracefulShutdown', markStopping);
    events.on('pool:forcefulShutdown', markStopping);
    // Graphile Worker's signal handling does not wait for a retired runner:
    // its pool is already shutting down, so the handler exits the process once
    // the active runner's jobs end. A retired runner's delivery aborted now
    // usually fails its job for a retry before then; one still running at the
    // exit would leave its job locked for 4 hours.
    const onSignal = () => {
      signalled = true;
      if (!closing) {
        for (const retired of retiredRunners.keys()) abortDeliveries(retired);
      }
    };
    events.on('gracefulShutdown', onSignal);
    events.on('forcefulShutdown', onSignal);
    events.on('worker:fatalError', ({ worker, error }) => {
      startReplacing(state);
      reportLostWorker({
        error,
        workerId: worker.workerId,
        // Still set here; Graphile Worker clears it after this event.
        jobId: worker.getActiveJob()?.id,
      });
    });
    // Graphile Worker stops a runner whose cron or worker pool fails, as when
    // the crontab query every runner makes at start meets a database that is
    // going away, and rejects its promise. Nothing else would replace it.
    state.runner.promise.catch((error: unknown) => {
      if (closing || signalled || state.retiring) return;
      if (runner !== state.runner) return;
      console.warn(
        '[world-postgres] Graphile Worker stopped its runner over an error; starting another:',
        error
      );
      state.failed = true;
      startReplacing(state);
    });
  }

  /** Start replacing `state` unless that is under way or it is stopping. */
  function startReplacing(state: RunnerState) {
    if (closing || state.replacing) return;
    if (state.stopping && !state.failed) return;
    state.replacing = true;
    trackReplacement(replaceRunner(state));
  }

  /** Pass a loss to `onWorkerLost`, which must not break the queue. */
  function reportLostWorker(lost: LostWorker) {
    const warn = (error: unknown) => {
      console.warn('[world-postgres] onWorkerLost failed:', error);
    };
    try {
      Promise.resolve(onWorkerLost(lost) as unknown).catch(warn);
    } catch (error) {
      warn(error);
    }
  }

  /**
   * Whether `lost` no longer needs replacing: close() began, a signal is
   * shutting the runners down, Graphile Worker is stopping it on purpose, or
   * it is no longer the runner.
   */
  function isOutdated(lost: RunnerState) {
    if (closing || signalled || runner !== lost.runner) return true;
    return lost.stopping && !lost.failed;
  }

  /**
   * Start a runner in place of `lost`, and retire `lost` once the new one is
   * up. A start needs a connection (Graphile Worker migrates first), and a lost
   * worker usually means the database is going away, so while starts fail,
   * `lost` keeps running, its remaining workers retrying their fetches, and the
   * start is tried again with capped backoff. One start runs at a time, for as
   * long as connecting takes: a runner that comes up late would run the jobs
   * its workers had already claimed beside the one that took its place. The
   * active-run recovery world.start() runs is not repeated.
   */
  async function replaceRunner(lost: RunnerState): Promise<void> {
    try {
      const quickLosses = quickLossesBefore(lost, performance.now());
      if (quickLosses > 0) {
        await delayUnlessAborted(
          replacementBackoffMs(quickLosses - 1),
          closeController.signal
        );
      }
      for (let failures = 0; !isOutdated(lost); failures++) {
        if (await tryReplacing(lost, quickLosses, failures)) return;
        await delayUnlessAborted(
          replacementBackoffMs(failures),
          closeController.signal
        );
      }
    } finally {
      // Still the runner: let a later failure start another replacement.
      if (runner === lost.runner) lost.replacing = false;
    }
  }

  /**
   * One start in place of `lost`. Resolves to false if the start failed and
   * `lost` still needs replacing, and to true once nothing is left to try. A
   * runner that came up when it was no longer needed is retired.
   */
  async function tryReplacing(
    lost: RunnerState,
    quickLosses: number,
    failures: number
  ): Promise<boolean> {
    let fresh: RunnerState;
    try {
      fresh = await createRunner(quickLosses);
    } catch (error) {
      if (isOutdated(lost)) return true;
      console.warn(
        `[world-postgres] Failed to start a Graphile Worker runner to replace one; retrying in ${replacementBackoffMs(failures)}ms:`,
        error
      );
      return false;
    }
    if (isOutdated(lost)) {
      retireRunner(fresh);
      return true;
    }
    runner = fresh.runner;
    // Graphile Worker is already stopping a failed runner, aborting its jobs
    // after the usual grace period. Of the runners the queue retires, only the
    // latest runs its deliveries without a time limit.
    if (!lost.failed) {
      graceRetiredRunners();
      retireRunner(lost);
    }
    return true;
  }

  /**
   * Run a delivery under its own signal. Graphile Worker aborts a stopping
   * runner's job signals once its grace period passes, which is how close()
   * and a signal-handled shutdown cut a stalled delivery short. A runner
   * retired after a replacement took its place is stopped the same way, but
   * its deliveries are healthy and must finish: aborted, each would lose an
   * attempt and be redelivered while its handler might still be running. So a
   * retiring runner's deliveries ignore Graphile Worker's abort, and the queue
   * aborts them itself when it should (see retireRunner).
   */
  async function withDeliverySignal<T>(
    deliveries: RunnerDeliveries,
    graphileSignal: AbortSignal | undefined,
    deliver: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const forward = () => {
      if (!deliveries.retiring) controller.abort(graphileSignal?.reason);
    };
    if (graphileSignal?.aborted) forward();
    else graphileSignal?.addEventListener('abort', forward, { once: true });
    if (deliveries.aborted) controller.abort();
    deliveries.inFlight.add(controller);
    try {
      return await deliver(controller.signal);
    } finally {
      graphileSignal?.removeEventListener('abort', forward);
      deliveries.inFlight.delete(controller);
    }
  }

  /** Abort a retired runner's deliveries, and any it starts from now on. */
  function abortDeliveries(deliveries: RunnerDeliveries) {
    deliveries.aborted = true;
    for (const delivery of deliveries.inFlight) delivery.abort();
  }

  /** Abort a retired runner's deliveries once the grace period passes. */
  function abortDeliveriesAfterGrace(deliveries: RunnerDeliveries) {
    if (deliveries.graceTimer || deliveries.aborted) return;
    deliveries.graceTimer = setTimeout(
      () => abortDeliveries(deliveries),
      SHUTDOWN_ABORT_TIMEOUT_MS
    );
    deliveries.graceTimer.unref?.();
  }

  /** Give each retired runner's deliveries the grace period from now. */
  function graceRetiredRunners() {
    for (const retired of retiredRunners.keys()) {
      abortDeliveriesAfterGrace(retired);
    }
  }

  /**
   * Stop a runner that is no longer `runner`. Its idle workers stop at once.
   * A worker running a job, or fetching one, finishes that job and records it
   * as usual. Its deliveries are aborted after the grace period once a newer
   * runner is retired or close() stops the active runner, and at once on a
   * signal (see withDeliverySignal). close() waits for it.
   */
  function retireRunner(state: RunnerState) {
    state.retiring = true;
    state.stopping = true;
    if (signalled) abortDeliveries(state);
    else if (closing) abortDeliveriesAfterGrace(state);
    const stopped = (async () => {
      try {
        await state.runner.stop();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'Runner is already stopped'
        ) {
          console.warn(
            '[world-postgres] Failed to stop a retired Graphile Worker runner:',
            error
          );
        }
      }
      await state.runner.promise.catch(() => {});
    })().finally(() => {
      if (state.graceTimer) clearTimeout(state.graceTimer);
      retiredRunners.delete(state);
    });
    retiredRunners.set(state, stopped);
  }

  /** For close(): no replacement starts after this. */
  function stopReplacing() {
    closeController.abort();
  }

  /** Keep `work` in `replacements` until it settles. */
  function trackReplacement(work: Promise<void>) {
    const tracked = work.finally(() => {
      replacements.delete(tracked);
    });
    replacements.add(tracked);
  }

  /**
   * For close(), once the active runner is stopped: wait for replacements
   * still starting, which retire the runner they bring up, and for retired
   * runners finishing their jobs. Settling a replacement can retire a runner,
   * so this waits until none is left. Like stopping the active runner, which
   * queries the database, a start under way is not bounded here against a
   * database that stops responding.
   */
  async function settleReplacements() {
    while (replacements.size > 0 || retiredRunners.size > 0) {
      await Promise.all([...replacements, ...retiredRunners.values()]);
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    ...(invocations ? { invoke } : {}),
    start,
    async close() {
      closing = true;
      stopReplacing();
      await invocations?.close();
      if (runnerStart) {
        runnerStart.controller.abort();
        await runnerStart.promise;
        runnerStart = null;
      }
      await startPromise?.catch(() => {});
      const activeRunner = runner;
      if (activeRunner) {
        // Retired runners' deliveries get the grace period that the active
        // runner's jobs get from its stop.
        graceRetiredRunners();
        try {
          await activeRunner.stop();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'Runner is already stopped'
          ) {
            throw error;
          }
        }
        await activeRunner.promise.catch(() => {});
        runner = null;
      }
      // A retired runner can still be finishing jobs, and a job that finishes
      // after the worker utils are released cannot enqueue its follow-up.
      await settleReplacements();
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
      startPromise = null;
      destroyNodeHttpAgents(httpAgents);
      await localWorld.close?.();
    },
  };
}
