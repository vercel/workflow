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
  createAppRouteUrl,
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
  createWorkflowUrl,
} from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  isSingleOrchestratorMessage,
  MessageId,
  messageRunSpecVersion,
  orchestratorRunIdOf,
  parseQueueName,
  parseQueueRoute,
  type Queue,
  QueuePayloadSchema,
  QueuePrefix,
  resolveQueueNamespace,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  singleOrchestratorRunIdOf,
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
import { type PostgresWorldConfig, resolveJobPrefix } from './config.js';
import { executeWithInputs } from './executor.js';
import { createInvocations } from './invocations.js';
import {
  createJobLeases,
  type JobLeasePolicy,
  resolveJobLeasePolicy,
} from './job-lease.js';
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
 * same steps). Crash recovery does not need one: `reenqueueActiveRuns`
 * re-enqueues active runs on start, and a running delivery renews its job
 * lock while any other process releases a job whose lock goes unrenewed
 * (because its process died), and the lock of its named queue, for
 * redelivery (see `job-lease.ts`). By default that release covers only the
 * per-run named queues (a spec 9 run's orchestrator deliveries, invoke mode's
 * executor lane) of renewing holders, after 300 seconds; with
 * `jobLockStaleSeconds` set it covers every job of this World after that
 * window, and `0` turns it off, leaving Graphile Worker's 4 hour reset
 * (`resetLockedAt`).
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
/**
 * Re-runs of one spec 9 orchestrator delivery for the run's orchestrator
 * messages that queued behind it (see `takeCoalescedJobs`), as world-vercel
 * bounds its coalesced re-runs. Past the cap the delivery acknowledges, and
 * the messages still waiting are delivered as usual.
 */
export const MAX_COALESCED_RERUNS = 32;
/**
 * Most waiting jobs one coalescing check claims. A run's named queue rarely
 * holds more than a fan-out's worth of wakes; the rest wait for the next
 * check.
 */
const COALESCE_BATCH_LIMIT = 500;
/**
 * Graphile priority of a spec 9 handoff's job: below the default 0, so the
 * continuation runs before the run's orchestrator messages that queued behind
 * it (Graphile takes the lowest priority first, then the earliest `run_at`).
 */
const HANDOFF_JOB_PRIORITY = -1;
/**
 * When the invocation that runs a delivery began (epoch ms), passed to the
 * handler as `invocationStartedAt`. The same for every coalesced re-run, so
 * a late re-run does not get a fresh inline budget.
 */
const INVOCATION_STARTED_AT_HEADER =
  'x-workflow-postgres-invocation-started-at';
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

/** A hook resume's timing, carried from a coalesced wake to the re-run. */
interface CoalescedResume {
  hookResumeTiming: unknown;
  traceCarrier?: unknown;
}

/** What one coalescing check removed (see `takeCoalescedJobs`). */
interface CoalescedJobs {
  removed: number;
  resume?: CoalescedResume;
}

/** Whether a queue message is a step's execution message. */
function isStepMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { stepId?: unknown }).stepId === 'string'
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
  /** Deliver a queue prefix's messages to `handler` in this process (see `Queue.registerHandler`). */
  registerHandler(
    prefix: QueuePrefix,
    handler: (req: Request) => Promise<Response>
  ): void;
  /** Deliver a queue prefix's messages over HTTP to `path` on the app (see `Queue.registerRoute`). */
  registerRoute(prefix: QueuePrefix, path: string): void;
};

export function createQueue(
  config: PostgresWorldConfig,
  pool: Pool,
  /** @internal Test hooks; not part of the public API. */
  internal?: {
    /** The `'named-queues'` default window, in place of 300 seconds. */
    defaultJobLockStaleSeconds?: number;
  }
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
    return `${resolveJobPrefix(config)}flows`;
  }

  const invocations = config.enableInvoke ? createInvocations(pool) : undefined;
  const leasePolicy: JobLeasePolicy = resolveJobLeasePolicy(
    config.jobLockStaleSeconds,
    internal?.defaultJobLockStaleSeconds
  );
  const jobLeases = createJobLeases(pool, {
    staleSeconds: leasePolicy.staleSeconds,
    ...(leasePolicy.scope === 'off' ? {} : { scope: leasePolicy.scope }),
  });
  /**
   * The Workflow SDK prefix this World serves: messages on it (and jobs that
   * predate the stored prefix) are workflow runs, which the run-scoped
   * executor lanes and the flow route are for. Any other prefix belongs to a
   * queue consumer of its own and is delivered as is.
   */
  const ownPrefix = () =>
    getQueueTopicPrefix('workflow', resolveQueueNamespace(config.namespace));
  /** In-process handlers by queue prefix (`registerHandler`). */
  const directHandlers = new Map<string, (req: Request) => Promise<Response>>();
  /** HTTP delivery routes by queue prefix (`registerRoute`). */
  const routes = new Map<string, string>();
  /**
   * The Graphile named queue of one run's orchestrator deliveries.
   *
   * Graphile runs the jobs of a named queue one at a time, across every
   * worker and process sharing the database, so a single-orchestrator run's
   * (spec >= 9) orchestrator deliveries never overlap: the queue half of the
   * single-writer guarantee (the in-band fence in storage.ts is the other).
   * Step messages, health checks and the messages of earlier runs carry no
   * queue name and keep full parallelism (see `singleOrchestratorRunIdOf`).
   * A delayed job (a timer, a `{ timeoutSeconds }` redelivery) does not hold
   * the queue: only a running job locks it.
   *
   * The invoke executor lane uses the same name, so a run's ordinary and
   * executor deliveries serialize with each other too, including while a
   * deployment switches `enableInvoke`.
   */
  const executorQueueName = (runId: string) =>
    `${getJobQueueName()}:${runId}:executor`;
  const executorTask = () => `${getJobQueueName()}_executor`;

  const createQueueHandler: Queue['createQueueHandler'] = (
    prefix,
    givenHandler
  ) => {
    // Passes the delivering worker's `invocationStartedAt` (set on the
    // request, see `deliverMessage`) through to the handler.
    const withInvocationStart =
      (req: Request): typeof givenHandler =>
      (message, metadata) => {
        const startedAt = Number(req.headers.get(INVOCATION_STARTED_AT_HEADER));
        return givenHandler(
          message,
          Number.isFinite(startedAt) && startedAt > 0
            ? { ...metadata, invocationStartedAt: startedAt }
            : metadata
        );
      };
    if (!invocations || prefix !== ownPrefix())
      return (req) =>
        localWorld.createQueueHandler(prefix, withInvocationStart(req))(req);
    return async (req) => {
      const handler = withInvocationStart(req);
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
              metadata.attempt,
              metadata.deliveryCount ?? metadata.attempt
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
    prefix,
    route,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
    jobKey,
    executorRunId,
    serialRunId,
    attemptOffset,
    deliveryOffset,
    createdAt,
    maxAttempts = MAX_GRAPHILE_JOB_ATTEMPTS,
    jobKeyMode = 'preserve_run_at',
    priority,
  }: {
    queueId: string;
    prefix?: QueuePrefix;
    route?: string;
    body: Buffer | Uint8Array;
    messageId: MessageId;
    createdAt?: string;
    attempt: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    delaySeconds?: number;
    jobKey?: string;
    /** Run the job on the invoke executor task, in this run's named queue. */
    executorRunId?: string;
    /** An orchestrator delivery for this run: run it in the run's named queue. */
    serialRunId?: string;
    attemptOffset?: number;
    deliveryOffset?: number;
    maxAttempts?: number;
    /**
     * What a job already holding `jobKey` does with this one (see
     * {@link jobKeyModeFor}). `'preserve_run_at'` replaces an unlocked job
     * (keeping its `run_at` while it has no attempts), and next to a locked
     * one inserts a second job. `'unsafe_dedupe'` makes the add a no-op
     * while any job holds the key, locked or not.
     */
    jobKeyMode?: 'preserve_run_at' | 'unsafe_dedupe';
    /** Graphile priority; lower runs first. Default 0. */
    priority?: number;
  }) {
    const utils = workerUtils;
    if (!utils) {
      throw new Error('Postgres queue worker utils are not initialized');
    }

    const runAt =
      typeof delaySeconds === 'number' && delaySeconds > 0
        ? new Date(Date.now() + delaySeconds * 1000)
        : undefined;

    const runQueue = executorRunId ?? serialRunId;
    await utils.addJob(
      executorRunId ? executorTask() : getJobQueueName(),
      MessageData.encode({
        id: queueId,
        ...(prefix ? { prefix } : {}),
        ...(route ? { route } : {}),
        data: Buffer.from(body),
        attempt,
        ...(attemptOffset !== undefined ? { attemptOffset } : {}),
        ...(deliveryOffset !== undefined ? { deliveryOffset } : {}),
        messageId,
        ...(createdAt ? { createdAt } : {}),
        idempotencyKey,
        headers,
      }),
      {
        ...(jobKey ? { jobKey, jobKeyMode } : {}),
        ...(runAt ? { runAt } : {}),
        ...(priority !== undefined ? { priority } : {}),
        maxAttempts,
        ...(runQueue ? { queueName: executorQueueName(runQueue) } : {}),
      }
    );
  }

  async function transferToExecutor(
    message: MessageData,
    runId: string,
    attempt: number,
    deliveryCount: number,
    remainingAttempts = Math.max(1, MAX_GRAPHILE_JOB_ATTEMPTS - attempt + 1)
  ) {
    await start();
    await addGraphileJob({
      queueId: message.id,
      prefix: message.prefix,
      route: message.route,
      body: message.data,
      messageId: message.messageId,
      createdAt: message.createdAt,
      attempt,
      attemptOffset: attempt - 1,
      deliveryOffset: deliveryCount - 1,
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

  /**
   * One delivery of a job: to the in-process handler registered for its
   * prefix, else over HTTP to the prefix's route (this worker's registration,
   * then the producer's), else to the Workflow SDK's flow route.
   */
  async function deliverMessage({
    queueName,
    prefix,
    route,
    messageId,
    createdAt,
    attempt,
    deliveryCount,
    body,
    headers: extraHeaders,
    abortSignal,
    executorDelivery,
    invocationStartedAt,
  }: {
    queueName: ValidQueueName;
    prefix: QueuePrefix;
    /** The route the producer recorded on the job, if any. */
    route?: string;
    messageId: MessageId;
    createdAt?: string;
    attempt: number;
    deliveryCount: number;
    body: Uint8Array;
    headers?: Record<string, string>;
    abortSignal?: AbortSignal;
    executorDelivery?: ExecutorDelivery;
    /** See {@link INVOCATION_STARTED_AT_HEADER}. */
    invocationStartedAt?: number;
  }): Promise<HttpExecutionResult> {
    const headers = new Headers(extraHeaders);
    headers.set('content-type', 'application/json');
    headers.set('x-vqs-queue-name', queueName);
    headers.set('x-vqs-message-id', messageId);
    headers.set('x-vqs-message-attempt', String(attempt));
    headers.set('x-vqs-message-delivery-count', String(deliveryCount));
    if (createdAt) headers.set('x-vqs-message-created-at', createdAt);
    else headers.delete('x-vqs-message-created-at');
    // Strip caller-supplied provenance case-insensitively. Only the verified
    // executor task may set these headers, including on retries.
    headers.delete(EXECUTOR_JOB_HEADER);
    headers.delete(EXECUTOR_WORKER_HEADER);
    headers.delete(EXECUTOR_ATTEMPT_HEADER);
    headers.delete(INVOCATION_STARTED_AT_HEADER);
    if (invocationStartedAt !== undefined) {
      headers.set(INVOCATION_STARTED_AT_HEADER, String(invocationStartedAt));
    }
    if (executorDelivery) {
      headers.set(EXECUTOR_JOB_HEADER, executorDelivery.id);
      headers.set(EXECUTOR_WORKER_HEADER, executorDelivery.worker);
      headers.set(EXECUTOR_ATTEMPT_HEADER, String(executorDelivery.attempt));
    }
    const directHandler = directHandlers.get(prefix);
    const deliveryRoute = routes.get(prefix) ?? route;
    let response: Response;
    if (directHandler) {
      // In process, like world-local's `registerHandler`: the request a
      // route serving `createQueueHandler(prefix, ...)` would get.
      const url = (baseUrl: string) =>
        deliveryRoute
          ? createAppRouteUrl(baseUrl, deliveryRoute)
          : createWorkflowUrl(baseUrl, { type: 'flow' });
      response = await directHandler(
        new Request(url(createWorkflowBaseUrl('http://localhost')), {
          method: 'POST',
          headers,
          body,
        })
      );
    } else {
      const baseUrl = await getExecutionBaseUrl();
      if (!baseUrl) {
        throw new Error('Unable to resolve base URL for workflow queue.');
      }
      // Queue shutdown aborts the delivery through Graphile's signal; the
      // deadlines are the operator's (see `getDeliveryTimeouts`).
      response = await nodeHttpFetch(
        deliveryRoute
          ? createAppRouteUrl(baseUrl, deliveryRoute)
          : createWorkflowUrl(baseUrl, { type: 'flow' }),
        {
          method: 'POST',
          headers: new Headers(headers),
          body,
          signal: abortSignal,
          agents: httpAgents,
          ...deliveryTimeouts,
        }
      );
    }
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

  /**
   * The Graphile job-key mode of a publish (`queue`). A follow-up job the
   * queue schedules itself (a reschedule, a transfer to the executor, a move
   * to a run's named queue) keeps `'preserve_run_at'`: it is sent while the
   * job it continues is locked, and must be inserted next to it.
   *
   * - A step's execution message (`stepId` set), of any run, and a
   *   single-orchestrator run's other keyed messages (spec >= 9: each hop of
   *   a wait's timer) are sent with a key only to be deduplicated: the
   *   runtime sends them again from later deliveries of the run (spec 9's
   *   re-send rule, a timer every delivery that may owe it sends; spec 8's
   *   republish of a delivery's step messages after a failed send, and its
   *   dispatch of a step another handler may already have queued), and a
   *   second job would be a second owner of the step's body, or a second
   *   chain of a long wait's hops. `'unsafe_dedupe'` makes the send a no-op
   *   while any job holds the key: a locked one (being delivered), one
   *   waiting out its delay, or one in retry backoff, whose attempts and
   *   `run_at` it keeps. The key is free again once the job completes and is
   *   deleted. A step's retry is not such a send: it is a reschedule of the
   *   step's own job.
   * - Any other keyed publish of an earlier run (spec 8's timers, hook wakes
   *   and backstops) keeps `'preserve_run_at'`: a duplicate may be an
   *   immediate replay of a delayed retry, and keeping the first job's
   *   `run_at` keeps that backoff.
   */
  const jobKeyModeFor = (
    message: unknown,
    idempotencyKey: string | undefined
  ): 'preserve_run_at' | 'unsafe_dedupe' =>
    idempotencyKey !== undefined &&
    (isSingleOrchestratorMessage(message) || isStepMessage(message))
      ? 'unsafe_dedupe'
      : 'preserve_run_at';

  const queue: Queue['queue'] = async (queue, message, opts) => {
    await start();
    const { prefix, id: queueId } = parseQueueName(queue);
    const body = transport.serialize(message) as Buffer;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const input =
      invocations && prefix === ownPrefix()
        ? executorInput(message)
        : undefined;
    await addGraphileJob({
      queueId,
      // Kept, so the job is delivered under the queue name it was sent to
      // whichever worker takes it, rather than the worker's own prefix.
      prefix,
      route: routes.get(prefix),
      body,
      messageId,
      createdAt: new Date().toISOString(),
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
      delaySeconds: opts?.delaySeconds,
      jobKey: opts?.idempotencyKey ?? messageId,
      jobKeyMode: jobKeyModeFor(message, opts?.idempotencyKey),
      // Only the SDK's own prefix carries workflow runs; a queue consumer's
      // own messages are never serialized by run.
      ...(input
        ? { executorRunId: input.runId }
        : prefix === ownPrefix()
          ? { serialRunId: singleOrchestratorRunIdOf(message) }
          : {}),
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

  /**
   * The spec version a run's row records, or `undefined` when the run is not
   * found, records none, or cannot be read. An unread version leaves the
   * message ungated, as before this check existed: the in-band fence keeps
   * an overlap safe, so a failed read must not fail the delivery.
   */
  async function readRunSpecVersion(
    runId: string
  ): Promise<number | undefined> {
    let value: number | string | null | undefined;
    try {
      const { rows } = await pool.query<{
        spec_version: number | string | null;
      }>('SELECT spec_version FROM workflow.workflow_runs WHERE id = $1', [
        runId,
      ]);
      value = rows[0]?.spec_version;
    } catch {
      return undefined;
    }
    // Migration 0005 created the column as `varchar` (drizzle's schema says
    // integer), so the driver returns a string on a migrated database.
    const specVersion =
      value === null || value === undefined ? Number.NaN : Number(value);
    return Number.isSafeInteger(specVersion) ? specVersion : undefined;
  }

  /**
   * Claims the jobs queued behind a spec 9 orchestrator delivery that it can
   * cover with a re-run (coalescing, as world-vercel does with its
   * concurrency key): the run's orchestrator messages on its named queue
   * that are due and not locked. Graphile runs a named queue's jobs one at a
   * time, so these are waiting for this delivery to finish. Returns how many
   * it removed.
   *
   * Removing them is safe for the reason it is safe on world-vercel: every
   * producer commits what an orchestrator message is for (a step outcome, a
   * `hook_received`, a cancellation) before it sends it, and the re-run reads
   * the log. `run.wakeUp()`'s waits are best-effort, and a final timer's wait
   * is found due by the re-run. An intermediate wait hop never reaches the
   * named queue (`singleOrchestratorRunIdOf`). A start message (`runInput`)
   * is left in place: it carries the run's input for a start that has not
   * committed its `run_created` yet.
   *
   * `complete_jobs` deletes only unlocked jobs, so a job another worker has
   * taken meanwhile is left to it.
   */
  async function takeCoalescedJobs(
    runId: string,
    ownJobId: string
  ): Promise<CoalescedJobs> {
    const utils = workerUtils;
    if (!utils) return { removed: 0 };
    const { rows } = await pool.query<{ id: string; payload: unknown }>(
      `SELECT jobs.id, jobs.payload
         FROM graphile_worker._private_jobs AS jobs
         JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
         JOIN graphile_worker._private_job_queues AS job_queues
           ON job_queues.id = jobs.job_queue_id
        WHERE job_queues.queue_name = $1
          AND tasks.identifier = $2
          AND jobs.id <> $3
          AND jobs.locked_at IS NULL
          AND jobs.run_at <= now()
        ORDER BY jobs.id
        LIMIT ${COALESCE_BATCH_LIMIT}`,
      [executorQueueName(runId), getJobQueueName(), ownJobId]
    );
    const ids: string[] = [];
    /** The resume timing each candidate carries, by job id. */
    const resumes = new Map<string, CoalescedResume>();
    for (const row of rows) {
      const message = MessageData.safeParse(row.payload);
      if (!message.success) continue;
      let body: unknown;
      try {
        body = await deserializeMessageBody(message.data.data);
      } catch {
        continue;
      }
      if (
        singleOrchestratorRunIdOf(body) !== runId ||
        (typeof body === 'object' &&
          body !== null &&
          ('runInput' in body || 'invoke' in body || 'hookInput' in body))
      ) {
        continue;
      }
      ids.push(String(row.id));
      const { hookResumeTiming, traceCarrier } = body as Record<
        string,
        unknown
      >;
      if (hookResumeTiming !== undefined) {
        resumes.set(String(row.id), {
          hookResumeTiming,
          ...(traceCarrier !== undefined && { traceCarrier }),
        });
      }
    }
    if (ids.length === 0) return { removed: 0 };
    const removed = await utils.completeJobs(ids);
    // The earliest removed wake that carries a hook resume's timing: the
    // re-run delivers it (see `rerunBody`).
    const removedIds = new Set(removed.map((job) => String(job.id)));
    const resume = ids
      .filter((id) => removedIds.has(id))
      .map((id) => resumes.get(id))
      .find((found) => found !== undefined);
    return { removed: removed.length, ...(resume && { resume }) };
  }

  /**
   * The body of a coalesced re-run: the delivery's own message, with the
   * resume timing (and trace context) of a hook wake it absorbed in place of
   * its own. The runtime starts a resume's TTR measurement only from the
   * `hookResumeTiming` of the message it handles, and the re-run is what
   * consumes the absorbed resume, so without this the measurement would be
   * lost. Its own timing is dropped either way: the first run consumed it,
   * and a re-run must not report that resume again.
   */
  function rerunBody(body: unknown, resume: CoalescedResume | undefined) {
    const { hookResumeTiming: _consumed, ...rest } = body as Record<
      string,
      unknown
    >;
    return transport.serialize(
      resume
        ? {
            ...rest,
            hookResumeTiming: resume.hookResumeTiming,
            ...(resume.traceCarrier !== undefined && {
              traceCarrier: resume.traceCarrier,
            }),
          }
        : rest
    ) as Buffer;
  }

  function createTaskHandler(queue: QueuePrefix, executor = false) {
    return async (payload: unknown, helpers: unknown) => {
      const messageData = MessageData.parse(payload);
      const graphileHelpers = GraphileHelpers.safeParse(helpers);
      const attempt = graphileHelpers.success
        ? graphileHelpers.data.job.attempts + (messageData.attemptOffset ?? 0)
        : messageData.attempt;
      // `attempt` is what core counts against its max-deliveries cap. A
      // `{ timeoutSeconds: n > 0 }` reschedule starts it over (as it always
      // has), so a step retried in place many times on one message is not
      // failed by the cap; a spec 9 handoff (`{ timeoutSeconds: 0 }`) carries
      // it over (`attemptOffset`). `deliveryCount` keeps counting across both,
      // and is what a spec 9 orchestrator's re-send rule reads.
      const deliveryCount = graphileHelpers.success
        ? graphileHelpers.data.job.attempts +
          (messageData.deliveryOffset ?? messageData.attemptOffset ?? 0)
        : messageData.attempt;
      // A job without a stored prefix predates it and is the worker's own.
      const prefix = messageData.prefix ?? queue;
      const queueName = `${prefix}${messageData.id}` as ValidQueueName;
      const body = await deserializeMessageBody(messageData.data);
      QueuePayloadSchema.parse(body);
      const orchestration =
        invocations && prefix === queue ? executorInput(body) : undefined;
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
            deliveryCount,
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
      } else if (prefix === queue && !executor) {
        // An orchestrator message without a spec stamp (an older SDK's
        // `resumeHook()` or `cancel()` during a rolling upgrade, another
        // client of the World) was published outside any run's named queue.
        // If its run is spec 9, stamp it with the run's version and move it
        // to the run's named queue, so it waits behind the run's live
        // delivery instead of running beside it. Only unstamped messages pay
        // the read; every message this runtime sends is stamped.
        const unstampedRunId =
          messageRunSpecVersion(body) === undefined
            ? orchestratorRunIdOf(body)
            : undefined;
        if (unstampedRunId !== undefined) {
          const specVersion = await readRunSpecVersion(unstampedRunId);
          if (
            specVersion !== undefined &&
            specVersion >= SPEC_VERSION_SINGLE_ORCHESTRATOR
          ) {
            const stamped = {
              ...(body as Record<string, unknown>),
              runSpecVersion: specVersion,
            };
            await addGraphileJob({
              queueId: messageData.id,
              prefix: messageData.prefix,
              route: messageData.route,
              body: transport.serialize(stamped) as Buffer,
              messageId: messageData.messageId,
              createdAt: messageData.createdAt,
              // Not a delivery: the moved job reports this one's counts.
              attempt,
              attemptOffset: attempt - 1,
              deliveryOffset: deliveryCount - 1,
              idempotencyKey: messageData.idempotencyKey,
              headers: messageData.headers,
              jobKey: `${getJobQueueName()}:stamped:${messageData.messageId}`,
              serialRunId: unstampedRunId,
            });
            return;
          }
        }
      }
      /**
       * The run whose orchestrator messages queued behind this delivery it
       * covers with re-runs (`takeCoalescedJobs`): a spec 9 orchestrator
       * delivery on the run's named queue. Not on the invoke executor lane,
       * whose deliveries also drive the run's invocation mailbox.
       */
      const coalescingRunId =
        !orchestration &&
        prefix === queue &&
        graphileHelpers.success &&
        graphileHelpers.data.job.id !== undefined
          ? singleOrchestratorRunIdOf(body)
          : undefined;
      const ownJobId = graphileHelpers.success
        ? graphileHelpers.data.job.id
        : undefined;
      const invocationStartedAt = Date.now();
      const executeTask = async (): Promise<'completed' | 'rescheduled'> => {
        let rerun = 0;
        let result: HttpExecutionResult;
        let deliveryBody: Buffer | Uint8Array = messageData.data;
        for (;;) {
          result = await deliverMessage({
            queueName,
            prefix,
            route: messageData.route,
            messageId: messageData.messageId,
            createdAt: messageData.createdAt,
            attempt,
            // A coalesced re-run reports the next delivery count and the
            // same attempt, so the runtime reads the log as on a
            // redelivery (see `Queue.createQueueHandler`).
            deliveryCount: deliveryCount + rerun,
            body: deliveryBody,
            headers: messageData.headers,
            executorDelivery,
            invocationStartedAt,
            abortSignal: graphileHelpers.success
              ? graphileHelpers.data.abortSignal
              : undefined,
          });
          if (
            result.type !== 'completed' ||
            coalescingRunId === undefined ||
            ownJobId === undefined ||
            rerun >= MAX_COALESCED_RERUNS
          ) {
            break;
          }
          const coalesced = await takeCoalescedJobs(coalescingRunId, ownJobId);
          if (coalesced.removed === 0) break;
          deliveryBody = rerunBody(body, coalesced.resume);
          rerun++;
        }

        if (result.type === 'completed') {
          return 'completed';
        }

        if (result.type === 'reschedule') {
          // On a single-orchestrator run, `{ timeoutSeconds: 0 }` is a
          // handoff: the next delivery continues this one and reports the
          // same `attempt` (see `Queue.createQueueHandler`). Core derives a
          // delivery's creator identity from `attempt`, so a crash
          // redelivery that hands off must stay a redelivery for its
          // successor.
          const handoff =
            result.timeoutSeconds === 0 && isSingleOrchestratorMessage(body);
          // A spec 9 orchestrator's `{ timeoutSeconds: n > 0 }` (a
          // redelivery after the in-band fence refused its write, or a run
          // deferred for load) is a counted redelivery of the same message,
          // as on world-vercel and world-local: it carries `attempt` over,
          // so a run refused on every pass reaches the delivery cap
          // (`MAX_DELIVERIES_EXCEEDED`) instead of looping. A step message's
          // in-place retry still starts `attempt` over.
          const countedRedelivery =
            !handoff &&
            isSingleOrchestratorMessage(body) &&
            orchestratorRunIdOf(body) !== undefined;
          const currentDeliveryCount = deliveryCount + rerun;
          // Schedule the follow-up job before we return so a crash cannot
          // lose the wake-up request.
          await addGraphileJob({
            queueId: messageData.id,
            prefix: messageData.prefix,
            route: messageData.route,
            body: messageData.data,
            // The same message: its id and creation time carry over. The
            // replacement is a new Graphile job whose own attempt count
            // starts again at 1; the deliveries made so far ride along as
            // `deliveryOffset`, so the handler sees the next deliveryCount.
            // A handoff also carries the attempts so far as
            // `attemptOffset`; any other reschedule starts `attempt` over,
            // so a step retried in place many times on one message is not
            // failed by core's max-deliveries cap.
            messageId: messageData.messageId,
            createdAt: messageData.createdAt,
            attempt: handoff ? attempt : attempt + 1,
            attemptOffset: handoff
              ? attempt - 1
              : countedRedelivery
                ? attempt
                : messageData.attemptOffset,
            deliveryOffset: currentDeliveryCount,
            idempotencyKey: messageData.idempotencyKey,
            headers: messageData.headers,
            delaySeconds: result.timeoutSeconds,
            // A handoff goes to the front of the run's named queue, ahead of
            // the orchestrator messages that queued behind this delivery.
            ...(handoff ? { priority: HANDOFF_JOB_PRIORITY } : {}),
            jobKey: messageData.idempotencyKey ?? messageData.messageId,
            ...(orchestration
              ? { executorRunId: orchestration.runId }
              : prefix === queue
                ? { serialRunId: singleOrchestratorRunIdOf(body) }
                : {}),
          });
          return 'rescheduled';
        }

        throw new Error(
          `[postgres world] Queue execution failed (${result.status}): ${result.text}`
        );
      };

      const idempotencyKey = messageData.idempotencyKey;
      if (!idempotencyKey) {
        // Wakes carry no key, and get no run-level exclusion here. A
        // single-orchestrator run's orchestrator deliveries are serialized by
        // its named queue (see `executorQueueName`), and its orchestrator
        // reads new events from the log itself while it runs an inline step.
        // An earlier run's delivery can hold an inline step until another
        // wake aborts it, and run-level exclusion would exclude that wake.
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
    const namespace = resolveQueueNamespace(config.namespace);
    const workflowPrefix = getQueueTopicPrefix('workflow', namespace);
    taskList[getJobQueueName()] = jobLeases.wrap(
      createTaskHandler(workflowPrefix)
    );
    if (invocations)
      taskList[executorTask()] = jobLeases.wrap(
        createTaskHandler(workflowPrefix, true)
      );

    runner = await run({
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
      taskList,
    });
    // Graphile Worker only resets locks older than 4 hours. Release this
    // World's jobs (including spec 9 orchestrator and invoke executor jobs
    // and their per-run queue locks) whose holders stopped renewing them. By
    // default only the per-run named queues' jobs, and only those of holders
    // registered as renewing (see `JobLeasePolicy`).
    jobLeases.startSweeper([getJobQueueName(), executorTask()], {
      prefix: `${getJobQueueName()}:`,
      suffix: ':executor',
    });
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    ...(invocations ? { invoke } : {}),
    registerHandler(prefix, handler) {
      directHandlers.set(QueuePrefix.parse(prefix), handler);
    },
    registerRoute(prefix, path) {
      routes.set(QueuePrefix.parse(prefix), parseQueueRoute(path));
    },
    start,
    async close() {
      closing = true;
      await invocations?.close();
      if (runnerStart) {
        runnerStart.controller.abort();
        await runnerStart.promise;
        runnerStart = null;
      }
      await startPromise?.catch(() => {});
      const activeRunner = runner;
      if (activeRunner) {
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
      // After the runner, whose active deliveries keep renewing while it
      // drains them.
      await jobLeases.stop();
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
