import * as Stream from 'node:stream';
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
  globalSingleton,
  IN_PROCESS_WORKER_STATE,
  type InProcessWorkerState,
} from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  getQueueTopicPrefix,
  HealthCheckPayloadSchema,
  IN_PROCESS_QUEUE_HANDLER,
  isSingleOrchestratorMessage,
  MessageId,
  messageRunSpecVersion,
  orchestratorRunIdOf,
  parseQueueName,
  parseQueueRoute,
  type Queue,
  type QueueDeliveryMeta,
  QueuePayloadSchema,
  QueuePrefix,
  type QueueRouteHandler,
  queueDeliveryHeaders,
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
import {
  type PostgresWorldConfig,
  resolveJobPrefix,
  UNPINNED_DEPLOYMENT_ID,
} from './config.js';
import { executeWithInputs } from './executor.js';
import { createInvocations } from './invocations.js';
import {
  createJobLeases,
  type JobLeasePolicy,
  resolveJobLeasePolicy,
} from './job-lease.js';
import { isJsonMode, operatorLog } from './logger.js';
import { MessageData } from './message.js';
import { createDeliveryHandler, createRunGate } from './queue-handler.js';
import { createRunLeases, isMissingTable, type LeftJob } from './run-lease.js';

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
 * (because its process died), for redelivery (see `job-lease.ts`). By
 * default that release covers only jobs that own a run's delivery lease (a
 * spec 9 run's orchestrator deliveries, invoke mode's executor lane; see
 * `run-lease.ts`) of renewing holders, after 300 seconds; with
 * `jobLockStaleSeconds` set it covers every job of this World after that
 * window, and `0` turns it off, leaving Graphile Worker's 4 hour reset
 * (`resetLockedAt`).
 */
export const DEFAULT_DELIVERY_HEADERS_TIMEOUT_MS = 0;
export const DEFAULT_DELIVERY_BODY_TIMEOUT_MS = 0;
/**
 * How long `start()` keeps sending its health check to the app's own flow
 * route (see `requestFlowRoute`): the server may not listen yet when its
 * startup hook calls `start()`, and a development server compiles the route
 * on the first request to it. Each attempt waits up to
 * `START_HEALTH_CHECK_ATTEMPT_MS` for the answer, and attempts are spaced by
 * a backoff from 100 ms up to 2 s.
 */
const START_HEALTH_CHECK_WINDOW_MS = 120_000;
const START_HEALTH_CHECK_ATTEMPT_MS = 60_000;
const START_HEALTH_CHECK_MAX_DELAY_MS = 2_000;
/** Backoff for a runner start that failed after the handler was registered. */
const RUNNER_RETRY_BASE_MS = 1_000;
const RUNNER_RETRY_MAX_MS = 30_000;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Per-delivery deadlines. `0` disables the deadline. An operator who prefers
 * a hung handler to be redelivered rather than hold its worker slot until
 * restart sets these to a value above the longest inline step they expect.
 * Over HTTP they are the request's headers and body deadlines; an in-process
 * delivery has the headers deadline to respond, and no body deadline.
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
 * Re-runs of one spec 9 orchestrator delivery for the wakes other
 * deliveries left on its run lease (see `run-lease.ts`), as world-vercel
 * bounds its coalesced re-runs. Past the cap the delivery releases the lease,
 * which re-adds the wake still left as a job.
 */
export const MAX_COALESCED_RERUNS = 32;
/**
 * How often a process with a runner recovers orphaned run leases (see
 * `RunLeases.recoverOrphans`). An owner can stop being able to run only
 * after the stale-lock sweep released it, so this need not be frequent.
 */
const ORPHANED_LEASE_INTERVAL_MS = 60_000;
/**
 * Graphile priority of a spec 9 handoff's job: below the default 0, so the
 * continuation, which the run's lease passes to, starts ahead of other work
 * (Graphile takes the lowest priority first, then the earliest `run_at`).
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

const GraphileHelpers = z.object({
  abortSignal: z.instanceof(AbortSignal).optional(),
  job: z.object({
    attempts: z.number().int().positive(),
    id: z.string().optional(),
    locked_by: z.string().nullable().optional(),
    task_identifier: z.string().optional(),
    max_attempts: z.number().int().positive().optional(),
  }),
});

type DeliveryResult =
  | { type: 'completed' }
  | { type: 'reschedule'; timeoutSeconds: number }
  | {
      type: 'error';
      status: number;
      text: string;
      headers: Record<string, string>;
    };

/** What the runtime's handler returned for a delivery, as the queue reads it. */
function deliveryResultOf(result: unknown): DeliveryResult {
  if (
    typeof result === 'object' &&
    result !== null &&
    'timeoutSeconds' in result
  ) {
    const timeoutSeconds = Number(result.timeoutSeconds);
    if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
      return { type: 'reschedule', timeoutSeconds };
    }
  }
  return { type: 'completed' };
}

/** The handler a World's `createQueueHandler` wraps: the runtime's. */
type DeliveryHandler = (
  message: unknown,
  meta: QueueDeliveryMeta
) => Promise<unknown>;

/**
 * Rejects when `signal` aborts, with the error a transport abort produces
 * (`AbortError`), so a delivery aborted by a shutdown or a deadline fails its
 * Graphile job and is redelivered, as an aborted HTTP delivery is. The
 * handler itself keeps running; the job is released, not the work. `cancel`
 * removes the listener once the delivery settled on its own: the signal may
 * be Graphile's, shared by every job of the runner, and must not keep one
 * listener per delivery.
 */
function untilAborted(signal: AbortSignal): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let cancel = () => {};
  const promise = new Promise<never>((_, reject) => {
    const fail = () => {
      const reason = signal.reason;
      if (reason instanceof Error && reason.name === 'AbortError') {
        reject(reason);
        return;
      }
      const error = new Error(
        reason instanceof Error ? reason.message : 'Delivery aborted'
      );
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
    cancel = () => signal.removeEventListener('abort', fail);
  });
  // The race may settle without it; nothing listens for a late rejection.
  promise.catch(() => {});
  return { promise, cancel };
}

/** `signal` with the deadline (ms, `0` for none), aborted when either is. */
function deliverySignal(
  signal: AbortSignal | undefined,
  deadlineMs: number
): AbortSignal | undefined {
  const signals = [
    ...(signal ? [signal] : []),
    ...(deadlineMs > 0 ? [AbortSignal.timeout(deadlineMs)] : []),
  ];
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** A hook resume's timing, carried from a coalesced wake to the re-run. */
interface CoalescedResume {
  hookResumeTiming: unknown;
  traceCarrier?: unknown;
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
  /**
   * Makes the queue ready to enqueue, and starts this World's Graphile
   * runner when this process is a worker: one that registered the Workflow
   * SDK's flow handler for this World's prefix (`registerHandler`). Every
   * other process (the CLI, the web UI, a script) only enqueues, and never
   * claims a job. A handler registered after `start()` starts the runner
   * then.
   */
  start(): Promise<void>;
  close(): Promise<void>;
  /** Deliver a queue prefix's messages to `handler` in this process (see `Queue.registerHandler`). */
  registerHandler(prefix: QueuePrefix, handler: QueueRouteHandler): void;
  /** Deliver a queue prefix's messages over HTTP to `path` on the app (see `Queue.registerRoute`). */
  registerRoute(prefix: QueuePrefix, path: string): void;
};

export function createQueue(
  config: PostgresWorldConfig,
  pool: Pool,
  /** @internal Test hooks; not part of the public API. */
  internal?: {
    /** The `'run-leases'` default window, in place of 300 seconds. */
    defaultJobLockStaleSeconds?: number;
    /** How often orphaned run leases are recovered, in place of 60 seconds. */
    orphanedLeaseIntervalMs?: number;
    /** Deferred messages one run lease keeps, in place of 100. */
    maxDeferredPerLease?: number;
    /** How long `start()` keeps trying its health check, in place of 120 seconds. */
    startHealthCheckWindowMs?: number;
  }
): PostgresQueue {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
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
  // The receiving side of the single-orchestrator gate: one run's orchestrator
  // deliveries run one at a time in this process (the run's delivery lease
  // serializes them across processes; see `run-lease.ts`). Held by the
  // delivery handler around the runtime's handler; see `createDeliveryHandler`.
  const handlerRunGate = createRunGate();
  const deliveryHandler: Queue['createQueueHandler'] = (prefix, handler) =>
    createDeliveryHandler(prefix, handler, {
      runGate: handlerRunGate,
      deserialize: transport.deserialize,
    });

  function getJobQueueName(
    deploymentId: string | undefined = config.deploymentId
  ): string {
    return `${resolveJobPrefix(config, deploymentId)}flows`;
  }

  /**
   * The task of another deployment's runs, when `opts.deploymentId` names one:
   * a pinned run's messages go to the workers of the deployment that started
   * it, wherever they are enqueued from, and an unpinned run's (one recorded
   * with {@link UNPINNED_DEPLOYMENT_ID}, such as a run started before
   * `deploymentId` was set) go to the unpinned task. `undefined` means this
   * World's own, as it does for an id that cannot name a deployment's task.
   */
  function deploymentTask(deploymentId: string | undefined) {
    if (
      deploymentId === undefined ||
      deploymentId === (config.deploymentId ?? UNPINNED_DEPLOYMENT_ID)
    ) {
      return undefined;
    }
    if (deploymentId === UNPINNED_DEPLOYMENT_ID) {
      return `${resolveJobPrefix({ jobPrefix: config.jobPrefix })}flows`;
    }
    try {
      return getJobQueueName(deploymentId);
    } catch {
      return undefined;
    }
  }

  const invocations = config.enableInvoke ? createInvocations(pool) : undefined;
  const leasePolicy: JobLeasePolicy = resolveJobLeasePolicy(
    config.jobLockStaleSeconds,
    internal?.defaultJobLockStaleSeconds
  );
  const runLeases = createRunLeases(
    pool,
    internal?.maxDeferredPerLease !== undefined
      ? { maxDeferred: internal.maxDeferredPerLease }
      : {}
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
  const directHandlers = new Map<string, QueueRouteHandler>();
  /**
   * Whether the Workflow SDK's flow handler (one with the in-process entry)
   * is registered here, under any prefix: the route registers for the
   * prefix it was built with (`WORKFLOW_QUEUE_NAMESPACE` at build time),
   * which is this World's own unless the two namespaces differ (see
   * `registerHandler`). A worker runs wherever that handler is.
   */
  const hasFlowHandler = () => {
    for (const handler of directHandlers.values()) {
      if (typeof handler[IN_PROCESS_QUEUE_HANDLER] === 'function') return true;
    }
    return false;
  };
  /** HTTP delivery routes by queue prefix (`registerRoute`). */
  const routes = new Map<string, string>();
  /**
   * A single-orchestrator run's (spec >= 9) orchestrator deliveries never
   * overlap: each takes the run's delivery lease before it runs
   * (`run-lease.ts`), across every worker and process sharing the database.
   * That is the queue half of the single-writer guarantee (the in-band fence
   * in storage.ts is the other). Step messages, health checks and the
   * messages of earlier runs take no lease and keep full parallelism (see
   * `singleOrchestratorRunIdOf`). A delayed job (a timer, a
   * `{ timeoutSeconds }` redelivery) holds no lease until it runs.
   *
   * The invoke executor lane takes the same lease, so a run's ordinary and
   * executor deliveries serialize with each other too, including while a
   * deployment switches `enableInvoke`.
   */
  const executorTask = () => `${getJobQueueName()}_executor`;

  /**
   * The invoke executor lane around the runtime's handler, for a delivery of
   * this World's own prefix when invoke is enabled. An orchestrator delivery
   * (`executorInput`) runs only on the run's executor task: one that arrived
   * elsewhere (`provenance.marked` false: an old worker's HTTP delivery, a
   * job that predates the lane) is moved there before being acknowledged.
   * One that runs there is admitted against Graphile's jobs view (the job
   * is active, owns the run's delivery lease, is held by this worker, at
   * this attempt): an admission check, not a fence on later journal writes. An invoke message
   * answers the mailbox; any other orchestrator delivery drives the run and
   * feeds it the pending inputs. Everything else (steps, health checks) runs
   * as is.
   */
  async function runExecutorLane(
    message: unknown,
    metadata: QueueDeliveryMeta,
    handler: DeliveryHandler,
    provenance: { marked: boolean; delivery: ExecutorDelivery | undefined }
  ): Promise<unknown> {
    if (!invocations) return handler(message, metadata);
    const input = executorInput(message);
    if (!input) {
      return handler(message, metadata);
    }
    if (!provenance.marked) {
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
    if (!provenance.delivery)
      throw new WorkflowWorldError('Invalid executor delivery metadata', {
        status: 400,
      });
    const proof = provenance.delivery;
    // Use Graphile's public jobs view, not private tables. This verifies the
    // actual active task/attempt and that the job owns the run's lease,
    // rather than trusting a boolean header. It is an admission check, NOT a
    // fence on later journal writes.
    const { rows } = await pool.query(
      `SELECT jobs.id FROM graphile_worker.jobs AS jobs
         JOIN workflow.workflow_run_delivery_leases AS leases
           ON leases.owner_job_id = jobs.id AND leases.run_id = $3
         WHERE jobs.id = $1 AND jobs.task_identifier = $2
           AND jobs.locked_by = $4 AND jobs.attempts = $5
           AND jobs.locked_at IS NOT NULL`,
      [proof.id, executorTask(), input.runId, proof.worker, proof.attempt]
    );
    if (rows.length === 0)
      throw new WorkflowWorldError(
        'Executor delivery does not hold the run lease',
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
      await invocations.respondOutcome(input.runId, input.requestId, outcome);
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
        await invocations.respondOutcome(input.runId, pending.id, outcome);
      }
    );
  }

  /**
   * The HTTP shape of a delivery to this World's own prefix (the flow route
   * while `WORKFLOW_QUEUE_AUTH=off` admits a worker on an earlier release).
   * The executor provenance travels in request headers there; only the
   * verified executor task sets them.
   */
  const createQueueHandler: Queue['createQueueHandler'] = (
    prefix,
    givenHandler
  ) => {
    // Passes the delivering worker's `invocationStartedAt` (a request header
    // on the HTTP shape, see `deliverMessage`) through to the handler.
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
      return (req) => deliveryHandler(prefix, withInvocationStart(req))(req);
    return async (req) => {
      const handler = withInvocationStart(req);
      const delivery = ExecutorDelivery.safeParse({
        id: req.headers.get(EXECUTOR_JOB_HEADER),
        worker: req.headers.get(EXECUTOR_WORKER_HEADER),
        attempt: req.headers.get(EXECUTOR_ATTEMPT_HEADER),
      });
      const marked = [
        EXECUTOR_JOB_HEADER,
        EXECUTOR_WORKER_HEADER,
        EXECUTOR_ATTEMPT_HEADER,
      ].some((header) => req.headers.has(header));
      return deliveryHandler(prefix, (message, metadata) =>
        runExecutorLane(message, metadata, handler, {
          marked,
          delivery: delivery.success ? delivery.data : undefined,
        })
      )(req);
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return config.deploymentId ?? UNPINNED_DEPLOYMENT_ID;
  };

  const completedMessages = new Set<string>();
  const inflightMessages = new Map<
    string,
    Promise<'completed' | 'rescheduled'>
  >();
  let workerUtils: WorkerUtils | null = null;
  let runner: Runner | null = null;
  /** The runner start in flight, if any (see `ensureRunner`). */
  let runnerStarting: Promise<void> | null = null;
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
    attemptOffset,
    deliveryOffset,
    createdAt,
    maxAttempts = MAX_GRAPHILE_JOB_ATTEMPTS,
    jobKeyMode = 'preserve_run_at',
    priority,
    handoffLease,
    task,
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
    /** Run the job on the invoke executor task. */
    executorRunId?: string;
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
    /**
     * The run lease this job continues, as a handoff: the job is added and
     * handed the lease in one transaction (see `RunLeases.handoff`).
     */
    handoffLease?: { runId: string; jobId: string };
    /** Another deployment's task ({@link deploymentTask}); default this World's. */
    task?: string;
  }): Promise<{ handedOff: boolean }> {
    const utils = workerUtils;
    if (!utils) {
      throw new Error('Postgres queue worker utils are not initialized');
    }

    const runAt =
      typeof delaySeconds === 'number' && delaySeconds > 0
        ? new Date(Date.now() + delaySeconds * 1000)
        : undefined;

    const jobTask =
      task ?? (executorRunId ? executorTask() : getJobQueueName());
    const payload = MessageData.encode({
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
    });
    if (handoffLease) {
      const handedOff = await runLeases.handoff(
        handoffLease.runId,
        handoffLease.jobId,
        {
          task: jobTask,
          payload,
          jobKey,
          jobKeyMode,
          maxAttempts,
          priority,
          runAt,
        }
      );
      return { handedOff };
    }
    await utils.addJob(jobTask, payload, {
      ...(jobKey ? { jobKey, jobKeyMode } : {}),
      ...(runAt ? { runAt } : {}),
      ...(priority !== undefined ? { priority } : {}),
      maxAttempts,
    });
    return { handedOff: false };
  }

  async function transferToExecutor(
    message: MessageData,
    runId: string,
    attempt: number,
    deliveryCount: number,
    remainingAttempts = Math.max(1, MAX_GRAPHILE_JOB_ATTEMPTS - attempt + 1)
  ) {
    await ensureStarted();
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

  /**
   * The app's base URL, for the HTTP delivery of a queue consumer's own
   * route (`registerRoute`). The Workflow SDK's own messages never go over
   * HTTP: they are delivered in process, to the registered flow handler.
   */
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

  /**
   * One delivery of a job. The Workflow SDK's own messages go to the
   * registered flow handler's in-process entry, with the message and its
   * metadata (a runner runs only where that handler is registered). A
   * registered handler without an entry (a consumer's own) gets the request
   * a route serving `createQueueHandler(prefix, ...)` would. A prefix with
   * no handler goes over HTTP to its route (this worker's registration, then
   * the producer's), else to the flow route, which refuses it unless
   * something registered a handler for it.
   */
  async function deliverMessage({
    queueName,
    prefix,
    route,
    messageId,
    createdAt,
    attempt,
    deliveryCount,
    message,
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
    /** The decoded message. */
    message: unknown;
    /** Its wire form, for a handler that takes a request. */
    body: Uint8Array;
    headers?: Record<string, string>;
    abortSignal?: AbortSignal;
    executorDelivery?: ExecutorDelivery;
    /** See {@link INVOCATION_STARTED_AT_HEADER}. */
    invocationStartedAt?: number;
  }): Promise<DeliveryResult> {
    const directHandler = directHandlers.get(prefix);
    const deliveryRoute = routes.get(prefix) ?? route;
    if (!directHandler && prefix === ownPrefix()) {
      // Unreachable while `ensureRunner` holds: this process claims jobs only
      // once the flow handler is registered, and `registerHandler` admits
      // only a handler with the in-process entry for this prefix. Never fall
      // back to HTTP for the Workflow SDK's messages.
      throw new Error(
        `[postgres world] No flow handler is registered in this process for queue prefix "${prefix}"; a worker runs only where the app registered it.`
      );
    }
    // Queue shutdown aborts the delivery through Graphile's signal, and the
    // headers deadline is the operator's (see `getDeliveryTimeouts`); either
    // rejects the delivery so the job is redelivered, while an in-process
    // handler finishes on its own.
    const signal = deliverySignal(
      abortSignal,
      deliveryTimeouts.headersTimeoutMs
    );
    const raceAbort = async <T>(promise: Promise<T>): Promise<T> => {
      if (!signal) return promise;
      const aborted = untilAborted(signal);
      try {
        return await Promise.race([promise, aborted.promise]);
      } finally {
        aborted.cancel();
      }
    };

    const entry = directHandler?.[IN_PROCESS_QUEUE_HANDLER];
    if (entry) {
      // In process, with the message and its metadata: no request, no wire
      // headers. The run gate serializes one run's orchestrator deliveries
      // in this process, as the HTTP shape's handler does.
      const meta: QueueDeliveryMeta = {
        queueName,
        messageId,
        attempt,
        deliveryCount,
        ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        // As the HTTP shape's header carries it: when the invocation that
        // runs this delivery began, the same for every coalesced re-run.
        ...(invocationStartedAt !== undefined ? { invocationStartedAt } : {}),
      };
      const orchestratorRunId = singleOrchestratorRunIdOf(message);
      const deliver: DeliveryHandler = (m, md) =>
        entry({ message: m, meta: md, ...(signal ? { signal } : {}) });
      // The gate is held until the handler settles, not until the job is
      // released: a delivery that outlives its deadline keeps running, and a
      // redelivery of the same run in this process must wait for it.
      const gated = async () => {
        const releaseRun =
          orchestratorRunId === undefined
            ? undefined
            : await handlerRunGate.acquire(`${prefix}${orchestratorRunId}`);
        // Abandoned while it waited (shutdown, or its deadline): the job is
        // Graphile's again, and a retry may already run elsewhere. Let the
        // next delivery of this run through instead of running a stale one.
        if (signal?.aborted) {
          releaseRun?.();
          return undefined;
        }
        try {
          return prefix === ownPrefix()
            ? await runExecutorLane(message, meta, deliver, {
                marked: executorDelivery !== undefined,
                delivery: executorDelivery,
              })
            : await deliver(message, meta);
        } finally {
          releaseRun?.();
        }
      };
      const pending = gated();
      // The race may have settled on the abort; a later rejection of the
      // handler is then nobody's to observe.
      pending.catch(() => {});
      return deliveryResultOf(await raceAbort(pending));
    }

    const headers = new Headers(extraHeaders);
    headers.set('content-type', 'application/json');
    // Under the current names and the earlier release's, so a route on the
    // earlier release still reads them.
    for (const [name, value] of Object.entries(
      queueDeliveryHeaders({
        queueName,
        messageId,
        attempt,
        deliveryCount,
        createdAt,
      })
    )) {
      headers.set(name, value);
    }
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
    let response: Response;
    if (directHandler) {
      // In process, as the request a route serving
      // `createQueueHandler(prefix, ...)` would get.
      const url = (baseUrl: string) =>
        deliveryRoute
          ? createAppRouteUrl(baseUrl, deliveryRoute)
          : createWorkflowUrl(baseUrl, { type: 'flow' });
      const request = new Request(
        url(createWorkflowBaseUrl('http://localhost')),
        { method: 'POST', headers, body, ...(signal ? { signal } : {}) }
      );
      response = await raceAbort(directHandler(request));
    } else {
      const baseUrl = await getExecutionBaseUrl();
      if (!baseUrl) {
        throw new Error('Unable to resolve base URL for workflow queue.');
      }
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
      return deliveryResultOf(JSON.parse(text));
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

  /**
   * Starts the Graphile runner once this process is a worker: the queue is
   * started (`workerUtils` is ready), it is not closing, and the Workflow
   * SDK's flow handler is registered (`hasFlowHandler`). Called from
   * `start()` and from `registerHandler()`, whichever comes second. At most
   * one runner: a start in flight is shared, not repeated.
   */
  function ensureRunner(): Promise<void> {
    if (runnerStarting) return runnerStarting;
    if (closing || runner || !workerUtils || !hasFlowHandler()) {
      return Promise.resolve();
    }
    runnerStarting = setupListeners().finally(() => {
      runnerStarting = null;
    });
    return runnerStarting;
  }

  let runnerRetry: ReturnType<typeof setTimeout> | null = null;
  let runnerRetryAttempt = 0;
  /**
   * Starts the runner for a handler registered after `start()`, and keeps
   * trying with a capped backoff when the start fails: a worker-only process
   * never publishes, so nothing else would start its runner. `close()`
   * cancels a pending retry.
   */
  function startRunnerForRegistration(): void {
    ensureRunner().then(
      () => {
        runnerRetryAttempt = 0;
      },
      (error) => {
        if (closing) return;
        runnerRetryAttempt += 1;
        const delayMs = Math.min(
          RUNNER_RETRY_BASE_MS * 2 ** (runnerRetryAttempt - 1),
          RUNNER_RETRY_MAX_MS
        );
        operatorLog.error(
          `Failed to start Graphile Worker after the flow handler was registered; retrying in ${delayMs} ms (attempt ${runnerRetryAttempt}). Until it starts, this process runs no jobs.`,
          error
        );
        runnerRetry = setTimeout(() => {
          runnerRetry = null;
          if (!closing) startRunnerForRegistration();
        }, delayMs);
        runnerRetry.unref?.();
      }
    );
  }

  /**
   * `start()` for the World's own use (a publish, an invoke, a transfer):
   * the schema and the worker utils, and the runner where the flow handler
   * is registered. Without the note `start()` leaves for a caller.
   */
  async function ensureStarted(): Promise<void> {
    if (closing) {
      return;
    }

    if (!startPromise) {
      startPromise = (async () => {
        try {
          const utils = await makeWorkerUtils({
            pgPool: pool,
            logger: graphileLogger,
          });
          await utils.migrate();
          await migratePgBossJobs(utils);
          // Published only now: `ensureRunner` (from `registerHandler`) must
          // not start a runner against a schema still being migrated.
          workerUtils = utils;
        } catch (err) {
          startPromise = null;
          throw err;
        }
      })();
    }
    await startPromise;
    await ensureRunner();
  }

  let enqueueOnlyNoted = false;
  /** The namespace mismatch warning of `registerHandler` was said. */
  let namespaceMismatchNoted = false;
  /**
   * Said once per process: no flow handler is registered here, so this
   * process only enqueues and runs no jobs. Expected of the CLI, the web UI
   * or a script; the message says what an app that should run jobs has to
   * check (the SDK release, how it was built, the startup hook docs).
   */
  function noteEnqueueOnly(): void {
    if (closing || enqueueOnlyNoted || hasFlowHandler()) return;
    enqueueOnlyNoted = true;
    operatorLog.warn(
      'No flow handler is registered in this process, so it only enqueues and runs no jobs. Jobs run in a process that called world.start(): start() sends a health check to the app\'s own flow route, which hands itself to the World. If this process is the app and should run jobs, call world.start() when the server starts, and check that workflow and @workflow/core are on the same release as @workflow/world-postgres. See the Postgres World docs, "Start the World when your server starts" (https://workflow-sdk.dev/worlds/postgres#start-the-world-when-your-server-starts).'
    );
  }

  /**
   * Whether this process is an application server rather than the CLI or a
   * script: it has a socket listening for connections (any framework's
   * server, once it is up), or it is the Next.js server (NEXT_RUNTIME, set
   * before the server listens). Such a process is expected to have
   * registered the flow route; when it publishes without one, runs would
   * stay pending with nothing said, since its startup hook never ran or the
   * worker module was left out of its build. The web UI is a server too,
   * and is told once that it only enqueues, which is what it does.
   */
  /** Decided once: see `isApplicationServer`. */
  let notApplicationServer = false;
  function isApplicationServer(): boolean {
    if (notApplicationServer) return false;
    if (
      process.env.NEXT_RUNTIME === 'nodejs' ||
      process.getActiveResourcesInfo().includes('TCPServerWrap')
    ) {
      return true;
    }
    // Latched, so an enqueue-only process (the CLI, a script) does not scan
    // its handles on every publish. A server that publishes before it
    // listens is therefore not told; its startup hook is where the route is
    // registered anyway.
    notApplicationServer = true;
    return false;
  }

  async function start(): Promise<void> {
    await ensureStarted();
    // This process is the app (only the app calls `start()`): get its flow
    // route, so the worker runs here.
    if (!hasFlowHandler()) requestFlowRoute();
  }

  /** The health check of `requestFlowRoute`, while it runs. */
  let flowRouteRequest: Promise<void> | null = null;
  /** Aborts that health check on `close()`. */
  let flowRouteRequestAbort: AbortController | null = null;
  /**
   * Gets the app's flow route without any startup code in the app: marks
   * this process as the one that wants the route (`requested`, in the worker
   * state `@workflow/core` reads), then sends one health check to the app's
   * own flow route (`?__health`). The framework loads the route module to
   * answer it, and the route, seeing `requested`, hands itself to the World
   * (`registerHandler`) before it answers, which starts the runner. In the
   * background: the server usually does not listen yet when its startup hook
   * calls `start()`, so a check that cannot connect is retried, with a
   * backoff, for up to two minutes. Once per process; `close()` stops it.
   */
  function requestFlowRoute(): void {
    if (flowRouteRequest || closing) return;
    globalSingleton<InProcessWorkerState>(
      IN_PROCESS_WORKER_STATE.name,
      IN_PROCESS_WORKER_STATE.shapeVersion,
      () => ({ requested: false, registered: false, route: undefined })
    ).requested = true;
    const abort = new AbortController();
    flowRouteRequestAbort = abort;
    flowRouteRequest = sendStartHealthCheck(abort.signal)
      .catch((error) => {
        if (!closing) {
          operatorLog.error(
            'The health check start() sends to the flow route failed.',
            error
          );
        }
      })
      .finally(() => {
        flowRouteRequestAbort = null;
      });
  }

  async function sendStartHealthCheck(signal: AbortSignal): Promise<void> {
    const windowMs =
      internal?.startHealthCheckWindowMs ?? START_HEALTH_CHECK_WINDOW_MS;
    const deadline = Date.now() + windowMs;
    let delayMs = 100;
    let lastFailure: unknown;
    while (!closing && !hasFlowHandler()) {
      // Resolved on each attempt: the port a server listens on is found
      // only once it listens.
      const baseUrl = await getExecutionBaseUrl().catch(() => undefined);
      if (baseUrl) {
        const url = createWorkflowUrl(baseUrl, { type: 'health' });
        try {
          const response = await fetch(url, {
            // Every framework's flow route answers POST.
            method: 'POST',
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(START_HEALTH_CHECK_ATTEMPT_MS),
            ]),
          });
          await response.body?.cancel().catch(() => {});
          if (hasFlowHandler() || closing) return;
          if (response.ok) {
            // The route answered without registering: the URL reaches
            // another process, or a runtime that predates this mechanism.
            noteRouteNotRegistered(
              `${url} answered the health check, but the flow route did not register in this process.`
            );
            return;
          }
          lastFailure = `${url} answered ${response.status}`;
        } catch (error) {
          if (closing) return;
          lastFailure = error;
        }
      } else {
        lastFailure = 'the port the app listens on was not found';
      }
      if (Date.now() + delayMs > deadline) {
        noteRouteNotRegistered(
          `The health check to the app's own flow route did not succeed within ${windowMs >= 1000 ? `${Math.round(windowMs / 1000)} s` : `${windowMs} ms`} (last: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}).`
        );
        return;
      }
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          // One listener per wait, removed again, so a long retry does not
          // pile listeners up on the signal.
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        timer.unref?.();
        signal.addEventListener('abort', onAbort, { once: true });
      });
      delayMs = Math.min(delayMs * 2, START_HEALTH_CHECK_MAX_DELAY_MS);
    }
  }

  /** Said once: `start()` could not get the flow route. */
  function noteRouteNotRegistered(reason: string): void {
    if (closing || enqueueOnlyNoted || hasFlowHandler()) return;
    enqueueOnlyNoted = true;
    operatorLog.warn(
      `${reason} This process runs no jobs until the flow route registers, so runs stay pending. start() sends a health check to the app's own flow route at its base URL (WORKFLOW_LOCAL_BASE_URL when set, else http://localhost on PORT or the port this process listens on), and the route registers itself when it answers. Check that the app serves the flow route at that URL, and that workflow and @workflow/core are on the same release as @workflow/world-postgres. See the Postgres World docs, "Start the World when your server starts" (https://workflow-sdk.dev/worlds/postgres#start-the-world-when-your-server-starts).`
    );
  }

  /**
   * The Graphile job-key mode of a publish (`queue`). A follow-up job the
   * queue schedules itself (a reschedule, a transfer to the executor, a
   * stamped move) keeps `'preserve_run_at'`: it is sent while the
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
    await ensureStarted();
    // Cheap checks first: the resource scan runs only until the note is made
    // or a flow handler is registered.
    // A process that called `start()` is told by its health check instead.
    if (
      !enqueueOnlyNoted &&
      !flowRouteRequest &&
      !hasFlowHandler() &&
      isApplicationServer()
    ) {
      noteEnqueueOnly();
    }
    const { prefix, id: queueId } = parseQueueName(queue);
    const body = transport.serialize(message) as Buffer;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const task = deploymentTask(opts?.deploymentId);
    // Invoke mode's executor lane is this World's own; another deployment's
    // runs are delivered on its flow task, as without invoke.
    const input =
      invocations && !task && prefix === ownPrefix()
        ? executorInput(message)
        : undefined;
    await addGraphileJob({
      task,
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
    await ensureStarted();
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
          max_attempts => $3)`,
          [executorTask(), JSON.stringify(wake), MAX_GRAPHILE_JOB_ATTEMPTS]
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
   * The message of a coalesced re-run: the delivery's own message, with the
   * resume timing (and trace context) of a hook wake it absorbed in place of
   * its own. The runtime starts a resume's TTR measurement only from the
   * `hookResumeTiming` of the message it handles, and the re-run is what
   * consumes the absorbed resume, so without this the measurement would be
   * lost. Its own timing is dropped either way: the first run consumed it,
   * and a re-run must not report that resume again.
   */
  function rerunMessage(
    body: unknown,
    resume: CoalescedResume | undefined
  ): unknown {
    const { hookResumeTiming: _consumed, ...rest } = body as Record<
      string,
      unknown
    >;
    return resume
      ? {
          ...rest,
          hookResumeTiming: resume.hookResumeTiming,
          ...(resume.traceCarrier !== undefined && {
            traceCarrier: resume.traceCarrier,
          }),
        }
      : rest;
  }

  /** The hook resume's timing a wake left on a run lease carries, if any. */
  async function resumeOf(left: LeftJob): Promise<CoalescedResume | undefined> {
    const message = MessageData.safeParse(left.payload);
    if (!message.success) return undefined;
    let body: unknown;
    try {
      body = await deserializeMessageBody(message.data.data);
    } catch {
      return undefined;
    }
    if (typeof body !== 'object' || body === null) return undefined;
    const { hookResumeTiming, traceCarrier } = body as Record<string, unknown>;
    return hookResumeTiming === undefined
      ? undefined
      : {
          hookResumeTiming,
          ...(traceCarrier !== undefined && { traceCarrier }),
        };
  }

  /**
   * Whether a later delivery of the run covers this orchestrator message, so
   * that it can be left on the run's lease as a wake (see `run-lease.ts`), as
   * world-vercel coalesces it: every producer commits what such a message is
   * for (a step outcome, a `hook_received`, a cancellation) before it sends
   * it, and the re-run reads the log. `run.wakeUp()`'s waits are
   * best-effort, and a final timer's wait is found due by the re-run. A start
   * message (`runInput`) carries the run's input for a start that has not
   * committed its `run_created` yet, and a hook's input or an invocation
   * carries data of its own, so those are deferred and re-added instead.
   */
  function isCoveredWake(body: unknown): boolean {
    return !(
      typeof body === 'object' &&
      body !== null &&
      ('runInput' in body || 'invoke' in body || 'hookInput' in body)
    );
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
        if (
          !executor ||
          !graphileHelpers.success ||
          graphileHelpers.data.job.task_identifier !== executorTask()
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
        // client of the World) does not say it needs the run's lease. If its
        // run is spec 9, stamp it with the run's version and re-add it, so it
        // takes the lease and waits for the run's live delivery instead of
        // running beside it. Only unstamped messages pay the read; every
        // message this runtime sends is stamped.
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
            });
            return;
          }
        }
      }
      const job = graphileHelpers.success
        ? graphileHelpers.data.job
        : undefined;
      const ownJobId = job?.id;
      /**
       * The run whose delivery lease this delivery takes (`run-lease.ts`): a
       * spec 9 orchestrator delivery's, or an invoke executor delivery's.
       */
      const leaseRunId =
        ownJobId === undefined
          ? undefined
          : orchestration
            ? orchestration.runId
            : prefix === queue
              ? singleOrchestratorRunIdOf(body)
              : undefined;
      /**
       * Whether this delivery re-runs for the wakes other deliveries leave
       * on its lease. Not on the invoke executor lane, whose deliveries also
       * drive the run's invocation mailbox.
       */
      const coalescing = leaseRunId !== undefined && !orchestration;
      const invocationStartedAt = Date.now();
      const executeTask = async (): Promise<'completed' | 'rescheduled'> => {
        let leased = false;
        if (leaseRunId !== undefined && ownJobId !== undefined && job) {
          const remainingAttempts = Math.max(
            1,
            (job.max_attempts ?? MAX_GRAPHILE_JOB_ATTEMPTS) - job.attempts + 1
          );
          const claim = await runLeases.claim(
            leaseRunId,
            ownJobId,
            {
              task:
                job.task_identifier ??
                (executor ? executorTask() : getJobQueueName()),
              // Not a delivery: the re-added job reports this one's counts.
              payload: MessageData.encode({
                ...messageData,
                attempt,
                attemptOffset: attempt - 1,
                deliveryOffset: deliveryCount - 1,
              }),
              jobKey: messageData.idempotencyKey ?? messageData.messageId,
              maxAttempts: remainingAttempts,
              ...(orchestration ? { executor: true } : {}),
            },
            // An executor wake is covered by any later executor delivery,
            // which reads every pending invocation: it collapses into the
            // lease's one wake rather than piling up as deferred messages.
            isCoveredWake(body) ? 'wake' : 'deferred',
            typeof body === 'object' &&
              body !== null &&
              (body as { hookResumeTiming?: unknown }).hookResumeTiming !==
                undefined
          );
          // Left for the lease's owner, which re-runs for it or re-adds it.
          // Not 'completed': a re-added job under the same key must not be
          // skipped as already done in this process.
          if (claim.owner === false) return 'rescheduled';
          if (claim.owner === 'busy') {
            // The owner already has as many deferred messages as a lease
            // keeps: this one stays a job of its own, retried after a delay
            // that grows with its age (half of it, 1 to 60 seconds), and
            // takes the lease or a free slot then.
            const createdAtMs = messageData.createdAt
              ? Date.parse(messageData.createdAt)
              : Number.NaN;
            await addGraphileJob({
              task: job.task_identifier,
              queueId: messageData.id,
              prefix: messageData.prefix,
              route: messageData.route,
              body: messageData.data,
              messageId: messageData.messageId,
              createdAt: messageData.createdAt,
              attempt,
              attemptOffset: attempt - 1,
              deliveryOffset: deliveryCount - 1,
              idempotencyKey: messageData.idempotencyKey,
              headers: messageData.headers,
              delaySeconds: Number.isFinite(createdAtMs)
                ? Math.min(
                    60,
                    Math.max(1, Math.round((Date.now() - createdAtMs) / 2000))
                  )
                : 5,
              jobKey: messageData.idempotencyKey ?? messageData.messageId,
              maxAttempts: remainingAttempts,
              ...(orchestration ? { executorRunId: orchestration.runId } : {}),
            });
            return 'rescheduled';
          }
          leased = claim.owner === true;
        }
        let handedOff = false;
        try {
          return await deliverLeased();
        } finally {
          if (leased && !handedOff && leaseRunId && ownJobId) {
            await runLeases.release(leaseRunId, ownJobId);
          }
        }

        async function deliverLeased(): Promise<'completed' | 'rescheduled'> {
          let rerun = 0;
          let result: DeliveryResult;
          // The message as delivered: after a coalesced re-run, the body that
          // carries the absorbed hook wake's resume timing (`rerunMessage`),
          // decoded for the in-process entry and serialized for a request.
          let deliveryMessage: unknown = body;
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
              message: deliveryMessage,
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
              !leased ||
              !coalescing ||
              leaseRunId === undefined ||
              ownJobId === undefined ||
              rerun >= MAX_COALESCED_RERUNS
            ) {
              break;
            }
            const wake = await runLeases.takeWake(leaseRunId, ownJobId);
            if (wake === undefined) break;
            deliveryMessage = rerunMessage(body, await resumeOf(wake));
            deliveryBody = transport.serialize(deliveryMessage) as Buffer;
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
            const next = await addGraphileJob({
              queueId: messageData.id,
              prefix: messageData.prefix,
              route: messageData.route,
              // As last delivered: after a coalesced re-run, that is the body
              // carrying the absorbed hook wake's resume timing (`rerunMessage`).
              // A re-run that hands off before consuming it, at its invocation
              // deadline say, passes it on to the next invocation, as an
              // uncoalesced timed wake that hands off does.
              body: deliveryBody,
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
              ...(handoff ? { priority: HANDOFF_JOB_PRIORITY } : {}),
              jobKey: messageData.idempotencyKey ?? messageData.messageId,
              ...(orchestration ? { executorRunId: orchestration.runId } : {}),
              // A handoff's continuation takes the run's lease over, with the
              // wakes left on it, so the run's other deliveries keep waiting
              // for it rather than starting between the two.
              ...(handoff && leased && leaseRunId && ownJobId
                ? { handoffLease: { runId: leaseRunId, jobId: ownJobId } }
                : {}),
            });
            handedOff = next.handedOff;
            return 'rescheduled';
          }

          throw new Error(
            `[postgres world] Queue execution failed (${result.status}): ${result.text}`
          );
        }
      };

      const idempotencyKey = messageData.idempotencyKey;
      if (!idempotencyKey) {
        // Wakes carry no key, and get no run-level exclusion here. A
        // single-orchestrator run's orchestrator deliveries are serialized by
        // its delivery lease (see `run-lease.ts`), and its orchestrator
        // reads new events from the log itself while it runs an inline step.
        // An earlier run's delivery can hold an inline step until another
        // wake aborts it, and run-level exclusion would exclude that wake.
        await executeTask();
        return;
      }

      // A job whose key is being delivered in this process waits for that
      // delivery, and is acknowledged without its own only if that delivery
      // completed. One that rescheduled (a handoff's continuation, which is
      // this job's own message and can be taken while its predecessor is
      // still returning) or failed leaves this job to run.
      for (;;) {
        if (completedMessages.has(idempotencyKey)) {
          return;
        }
        const existing = inflightMessages.get(idempotencyKey);
        if (!existing) break;
        if ((await existing.catch(() => 'failed' as const)) === 'completed') {
          return;
        }
      }

      const execution = executeTask()
        .then((result) => {
          if (result === 'completed') {
            markMessageCompleted(idempotencyKey);
          }
          return result;
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
      // packages/core/src/runtime/eager-processing.md for context.
      concurrency: config.queueConcurrency || 50,
      logger: graphileLogger,
      ...(config.applicationManagedShutdown === true && {
        noHandleSignals: true,
      }),
      pollInterval: config.pollInterval ?? 500, // per worker; LISTEN/NOTIFY only wakes idle workers early
      taskList,
    });
    // Graphile Worker only resets locks older than 4 hours. Release this
    // World's jobs (including spec 9 orchestrator and invoke executor jobs)
    // whose holders stopped renewing them. By default only jobs that own a
    // run's delivery lease, and only those of holders registered as renewing
    // (see `JobLeasePolicy`).
    jobLeases.startSweeper([getJobQueueName(), executorTask()]);
    scheduleOrphanRecovery();
  }

  const orphanedLeaseIntervalMs =
    internal?.orphanedLeaseIntervalMs ?? ORPHANED_LEASE_INTERVAL_MS;
  let orphanTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveringOrphans: Promise<void> | undefined;
  let orphanRecoveryFailing = false;

  /**
   * Periodically recover the run leases whose owner can no longer run (see
   * `RunLeases.recoverOrphans`), with jitter so the processes sharing the
   * database spread their checks. Every process with a runner recovers
   * every deployment's leases: a pinned deployment whose workers scaled to
   * zero runs no process of its own to recover them.
   */
  function scheduleOrphanRecovery() {
    if (closing || orphanTimer || orphanedLeaseIntervalMs <= 0) return;
    orphanTimer = setTimeout(
      () => {
        orphanTimer = undefined;
        recoveringOrphans = recoverOrphanedLeases().finally(() => {
          recoveringOrphans = undefined;
          scheduleOrphanRecovery();
        });
      },
      orphanedLeaseIntervalMs * (0.8 + 0.4 * Math.random())
    );
    orphanTimer.unref?.();
  }

  async function recoverOrphanedLeases() {
    try {
      const recovered = await runLeases.recoverOrphans();
      orphanRecoveryFailing = false;
      if (recovered.leases > 0 && process.env.WORKFLOW_JSON_MODE !== '1') {
        console.warn(
          `[world-postgres] Recovered ${recovered.leases} run lease(s) whose owner job can no longer run, re-adding the ${recovered.jobs} message(s) left on them`
        );
      }
    } catch (error) {
      // A missing table (migration 0031) is reported by the leases' first
      // claim; anything else is retried on the next tick.
      if (
        !orphanRecoveryFailing &&
        !isMissingTable(error) &&
        process.env.WORKFLOW_JSON_MODE !== '1'
      ) {
        console.warn(
          '[world-postgres] Failed to recover orphaned run leases; retrying:',
          error
        );
      }
      orphanRecoveryFailing = true;
    }
  }

  return {
    // The Workflow SDK's messages are delivered in process, to the flow
    // handler the app registered (`registerHandler`), never over HTTP, so the
    // flow route refuses every HTTP delivery (the `?__health` probe still
    // answers), in every process: a process that was
    // never handed the route still serves it, and an HTTP request to it
    // could run a forged delivery there. The database credentials control
    // who can enqueue.
    queueAuthMode: 'deny',
    createQueueHandler,
    getDeploymentId,
    queue,
    ...(invocations ? { invoke } : {}),
    registerHandler(prefix, handler) {
      const parsed = QueuePrefix.parse(prefix);
      if (
        parsed === ownPrefix() &&
        typeof handler[IN_PROCESS_QUEUE_HANDLER] !== 'function'
      ) {
        // The SDK's messages go to the route's in-process entry only; a
        // request built for a handler without one would be refused by the
        // route itself (the flow route refuses HTTP deliveries). Refusing here, at
        // startup, says so once instead of failing every delivery.
        throw new Error(
          "[postgres world] The flow handler registered for the Workflow SDK's queue has no in-process entry (IN_PROCESS_QUEUE_HANDLER from @workflow/world), so the World cannot deliver to it: the flow route refuses HTTP deliveries. Hand the World the generated flow route through registerWorkflowHandler() from workflow/runtime, which the framework integrations call when the app starts."
        );
      }
      if (
        !namespaceMismatchNoted &&
        parsed !== ownPrefix() &&
        typeof handler[IN_PROCESS_QUEUE_HANDLER] === 'function'
      ) {
        // The route was built with another WORKFLOW_QUEUE_NAMESPACE than the
        // World's `namespace` option. Its messages are delivered, but as a
        // queue consumer's: the per-run ordering and the executor lanes are
        // kept for this World's own prefix only. Said once per process: a
        // route re-registers itself (a development rebuild, a worker module
        // that registers before it starts the World).
        namespaceMismatchNoted = true;
        operatorLog.warn(
          `The flow handler is registered for queue prefix "${parsed}", but this World's namespace gives "${ownPrefix()}", so the Workflow SDK's messages are delivered as a queue consumer's, without the per-run ordering kept for the World's own prefix, and the runs this World re-enqueues at startup go to "${ownPrefix()}", which no handler here takes. Set WORKFLOW_QUEUE_NAMESPACE at build time to the World's namespace option, so both name the same prefix.`
        );
      }
      directHandlers.set(parsed, handler);
      // Registered after `start()`: this process is a worker from now on.
      // Before it, `start()` starts the runner itself.
      startRunnerForRegistration();
    },
    registerRoute(prefix, path) {
      routes.set(QueuePrefix.parse(prefix), parseQueueRoute(path));
    },
    start,
    async close() {
      closing = true;
      flowRouteRequestAbort?.abort();
      await flowRouteRequest;
      flowRouteRequest = null;
      if (runnerRetry) {
        clearTimeout(runnerRetry);
        runnerRetry = null;
      }
      await invocations?.close();
      await startPromise?.catch(() => {});
      await runnerStarting?.catch(() => {});
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
      clearTimeout(orphanTimer);
      orphanTimer = undefined;
      await recoveringOrphans;
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
      startPromise = null;
      destroyNodeHttpAgents(httpAgents);
    },
  };
}
