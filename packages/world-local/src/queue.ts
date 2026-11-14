import { setTimeout } from 'node:timers/promises';
import type { Transport } from '@vercel/queue';
import {
  createAppRouteUrl,
  createLogLimiter,
  createWorkflowUrl,
  debugLog,
  getQueueAuthKey,
  isQueueAuthRefusal,
  QUEUE_AUTH_HEADER,
} from '@workflow/utils';
import {
  isNodeHttpEnabled,
  isSingleOrchestratorMessage,
  MessageId,
  messageRunSpecVersion,
  orchestratorRunIdOf,
  parseQueueName,
  parseQueueRoute,
  type Queue,
  QueuePrefix,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  singleOrchestratorRunIdOf,
  ValidQueueName,
  WORKFLOW_FLOW_ROUTE,
} from '@workflow/world';
import {
  createNodeHttpAgents,
  destroyNodeHttpAgents,
  nodeHttpFetch,
} from '@workflow/world/node-http.js';
import { Sema } from 'async-sema';
import { monotonicFactory } from 'ulid';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import type { BlockedRuns } from './blocked-runs.js';
import type { Config } from './config.js';
import {
  LOCAL_QUEUE_CONCURRENCY,
  resolveBaseUrl,
  resolveDirectBaseUrl,
} from './config.js';
import { jsonReplacer, jsonReviver } from './db/codec.js';
import { databaseFor } from './db/index.js';
import { getPackageInfo } from './init.js';
import type { QueueAuthKey } from './queue-auth-key.js';

/**
 * JSON transport that preserves Uint8Array values using the same
 * replacer/reviver that world-local uses for filesystem storage.
 * Uint8Array → { __type: 'Uint8Array', data: '<base64>' } in JSON.
 */
class TypedJsonTransport implements Transport<unknown> {
  readonly contentType = 'application/json';

  serialize(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value, jsonReplacer));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString();
    return JSON.parse(text, jsonReviver);
  }
}

// For local queue, there is no technical limit on the message visibility lifespan,
// but the environment variable can be used for testing purposes to set a max visibility limit.
const LOCAL_QUEUE_MAX_VISIBILITY =
  parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
  Infinity;

// Maximum safe delay for setTimeout in Node.js (2^31 - 1 milliseconds ≈ 24.85 days)
// Larger values cause "TimeoutOverflowWarning: X does not fit into a 32-bit signed integer"
// When the clamped timeout fires, the handler will recalculate remaining time from
// persistent state and return another timeoutSeconds if needed.
export const MAX_SAFE_TIMEOUT_MS = 2147483647;

// How long close() waits for first delivery attempts already under way (see
// `firstAttempts` in createQueue) before it aborts them. The app's handler
// does not stop when the sender goes away, so close() only has to wait until
// the app has the request, not for its answer.
//
// A message for a run is waited for until the app has written to the run
// (its `seq` moved past where it was when the message was sent), up to
// CLOSE_RUN_MESSAGE_WAIT_MS: long enough for a dev server that compiles the
// flow route on its first request. Any other message is waited for up to
// CLOSE_FIRST_ATTEMPT_WAIT_MS, which covers getting it to a warm app.
const CLOSE_FIRST_ATTEMPT_WAIT_MS = 1_000;
const CLOSE_RUN_MESSAGE_WAIT_MS = 10_000;
const CLOSE_POLL_MS = 50;

/** A message's first delivery attempt, while close() may wait for it. */
interface FirstAttempt {
  /** Settles when the attempt has an answer, or has failed. */
  done: Promise<void>;
  runId?: string;
  /** The run's `seq` when the message was sent; undefined for no run. */
  seqAtSend?: number;
}

/**
 * The most deliveries world-local makes of one message (handoffs aside): a
 * guard against a message that fails forever. The runtime enforces its own
 * delivery cap well below it.
 */
export const MAX_LOCAL_SAFETY_LIMIT = 256;

/**
 * Refusals of one message (the runtime's marked 401) after which the key file
 * still holds the key that was sent, before world-local gives the message up.
 * A refusal after which the file holds a new key is retried at once and not
 * counted, however many rotations there are. The counted ones wait the short
 * backoff, by which time the route has re-read the file too (its re-reads are
 * rate-limited). Few, because a sender that cannot read the app's key is
 * refused every time.
 */
export const MAX_QUEUE_AUTH_REFUSALS = 5;

/**
 * Refusals of one message after which the key file held a new key, retried
 * at once and not counted. Rotations happen when one of the app's processes
 * starts, seconds apart; past this many for one message, the key is changing
 * on every attempt (something rewrites it in a loop), and further refusals
 * count like any other: they back off and give the message up. So a message
 * never spins, and ends after at most this plus MAX_QUEUE_AUTH_REFUSALS
 * deliveries, far below MAX_LOCAL_SAFETY_LIMIT.
 */
export const MAX_UNCOUNTED_KEY_ROTATIONS = 16;

/** Failed deliveries retried 5s apart, before the backoff grows. */
const LINEAR_RETRY_DELIVERIES = 32;
const LINEAR_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * The delay before world-local retries a message whose `failedDeliveries`-th
 * delivery failed: 5s for the first 32, as Vercel Queues does, then doubling
 * up to a minute. So the {@link MAX_LOCAL_SAFETY_LIMIT} deliveries of a
 * message that keeps failing span hours, longer than the runtime's stall
 * window for a step message (`QUEUE_MIN_STEP_REDELIVERY_SPAN_MS` in
 * `@workflow/world`), and a step whose every delivery throws is failed
 * rather than left with no message.
 */
export function localRetryDelayMs(failedDeliveries: number): number {
  if (failedDeliveries <= LINEAR_RETRY_DELIVERIES) return LINEAR_RETRY_DELAY_MS;
  return Math.min(
    MAX_RETRY_DELAY_MS,
    LINEAR_RETRY_DELAY_MS * 2 ** (failedDeliveries - LINEAR_RETRY_DELIVERIES)
  );
}

/**
 * Default time-to-first-byte deadline for local queue deliveries: none. A
 * delivery runs inline steps before it responds, so any client-side deadline
 * shorter than the longest step redelivers a live message and re-executes the
 * step while the original is still running (workflow#3909).
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 0;

/** Default maximum gap between response body chunks for local deliveries. */
export const DEFAULT_BODY_TIMEOUT_MS = 0;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Deliveries are unbounded by default. Operators who would rather a hung
 * handler be redelivered can opt in to a deadline; a transport timeout is then
 * retried by the delivery loop with the same durable message, so the deadline
 * must exceed the longest inline step.
 *
 * Both transports honor every field. Over undici this is the `Agent`'s own
 * configuration; over `node:http` (`WORKFLOW_NODE_HTTP`) the two timeouts are
 * passed per request and `connections` / `keepAliveTimeout` size the socket
 * pool, so the two env vars tune a delivery identically either way.
 */
export function getQueueAgentOptions() {
  return {
    bodyTimeout: envTimeoutMs(
      'WORKFLOW_LOCAL_BODY_TIMEOUT_MS',
      DEFAULT_BODY_TIMEOUT_MS
    ),
    connections: 1000,
    headersTimeout: envTimeoutMs(
      'WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS',
      DEFAULT_HEADERS_TIMEOUT_MS
    ),
    keepAliveTimeout: 30_000,
  } as const;
}

export type DirectHandler = (req: Request) => Promise<Response>;

export type LocalQueue = Queue & {
  /** Close the HTTP agent and release resources. */
  close(): Promise<void>;
  /** Register a direct in-process handler for a queue prefix, bypassing HTTP. */
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  /**
   * Route a queue prefix's HTTP deliveries to `path` on the app instead of
   * the Workflow SDK's flow route (see `Queue.registerRoute`).
   */
  registerRoute(prefix: QueuePrefix, path: string): void;
};

const QUEUE_AUTH_REFUSAL_HINT =
  "A queue delivery is accepted only with the app's key, from the file queue-auth-key in " +
  "the app's data directory. Run the sender on the same data directory as the app " +
  '(WORKFLOW_LOCAL_DATA_DIR) and on the same release. On a trusted network, set ' +
  'WORKFLOW_QUEUE_AUTH=off on the app to accept other senders (refused while dynamic ' +
  'workflows are enabled).';

const DETACHED_ARRAYBUFFER_ERROR =
  'Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer';
const PROXY_HANDLER_DOCS_URL =
  'https://workflow-sdk.dev/docs/getting-started/next#configure-proxy-handler';

function isDetachedArrayBufferQueueError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (
      'message' in current &&
      typeof current.message === 'string' &&
      current.message.includes(DETACHED_ARRAYBUFFER_ERROR)
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }

  return false;
}

/**
 * Per-run mutual exclusion for orchestrator deliveries, in FIFO order.
 *
 * `acquire(runId)` resolves once every earlier holder for that run has
 * released, with the release function. Keys are dropped when the last holder
 * releases, so the map holds only runs with a delivery in flight or waiting.
 */
export function createRunGate() {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(runId: string): Promise<() => void> {
      const previous = tails.get(runId) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      tails.set(runId, tail);
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (tails.get(runId) === tail) tails.delete(runId);
      };
    },
    /** Whether `runId`'s gate is held. */
    isHeld(runId: string): boolean {
      return tails.has(runId);
    },
    /** Runs with a delivery in flight or waiting. For tests. */
    size(): number {
      return tails.size;
    },
  };
}

/**
 * Most re-runs one hold of a run's orchestrator gate makes for the messages
 * coalesced into it, as world-vercel bounds its coalesced re-runs. Past the
 * cap the delivery releases the gate, and the messages still waiting are
 * delivered as usual.
 */
export const MAX_LOCAL_COALESCED_RERUNS = 32;

/**
 * When the hold of a run's orchestrator gate that a delivery belongs to
 * began (epoch ms), sent to the handler as `invocationStartedAt`: the same
 * for every coalesced re-run, so a late re-run does not get a fresh inline
 * budget.
 */
export const INVOCATION_STARTED_AT_HEADER =
  'x-workflow-local-invocation-started-at';

/** A hook resume's timing, carried from a coalesced wake to the re-run. */
export interface CoalescedResume {
  hookResumeTiming: unknown;
  traceCarrier?: unknown;
}

/** One hold of a run's orchestrator gate. */
export interface OrchestratorLease {
  /** Releases the gate to the next waiter. Idempotent. */
  release(): void;
  /**
   * Removes the coalescible waiters (see {@link createOrchestratorGate}) and
   * ends them without a delivery: this holder covers them with a re-run.
   * Returns how many, and the resume timing of the earliest that carries one.
   */
  takeWaiting(): { count: number; resume?: CoalescedResume };
}

/**
 * Per-run mutual exclusion for a queue's own orchestrator deliveries of
 * single-orchestrator (spec >= 9) runs, in FIFO order, with coalescing.
 *
 * `acquire(key, ...)` resolves with a lease once every earlier holder has
 * released, or with `undefined` when the holder took the waiter
 * (`takeWaiting`): its message was coalesced into the holder's delivery,
 * which runs the handler again instead of delivering it. Only a coalescible
 * waiter is taken: an orchestrator message whose payload carries nothing the
 * run's log does not hold.
 */
export function createOrchestratorGate() {
  interface Waiter {
    coalescible: boolean;
    resume?: CoalescedResume;
    grant: (lease: OrchestratorLease | undefined) => void;
  }
  /** Runs whose gate is held, with the waiters behind the holder. */
  const runs = new Map<string, Waiter[]>();
  const lease = (key: string): OrchestratorLease => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const waiters = runs.get(key);
        const next = waiters?.shift();
        if (!next) {
          runs.delete(key);
          return;
        }
        next.grant(lease(key));
      },
      takeWaiting() {
        const waiters = runs.get(key);
        if (released || !waiters) return { count: 0 };
        let count = 0;
        let resume: CoalescedResume | undefined;
        const kept: Waiter[] = [];
        for (const waiter of waiters) {
          if (!waiter.coalescible) {
            kept.push(waiter);
            continue;
          }
          count++;
          resume ??= waiter.resume;
          waiter.grant(undefined);
        }
        runs.set(key, kept);
        return { count, ...(resume && { resume }) };
      },
    };
  };
  return {
    acquire(
      key: string,
      options: { coalescible?: boolean; resume?: CoalescedResume } = {}
    ): Promise<OrchestratorLease | undefined> {
      const waiters = runs.get(key);
      if (!waiters) {
        runs.set(key, []);
        return Promise.resolve(lease(key));
      }
      return new Promise((grant) => {
        const waiter: Waiter = {
          coalescible: options.coalescible === true,
          ...(options.resume && { resume: options.resume }),
          grant,
        };
        waiters.push(waiter);
      });
    },
    /** Whether `key`'s gate is held. */
    isHeld(key: string): boolean {
      return runs.has(key);
    },
    /** Runs whose gate is held. For tests. */
    size(): number {
      return runs.size;
    },
  };
}

/**
 * Whether a handler's answer acknowledges the message: no `timeoutSeconds`
 * (a redelivery or a handoff), and not an invocation's result.
 */
function isAcknowledgement(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !('timeoutSeconds' in parsed) &&
      !('result' in parsed)
    );
  } catch {
    return false;
  }
}

/** Whether a handler's answer is `{ timeoutSeconds: 0 }`. */
function isHandoff(text: string): boolean {
  try {
    return Number(JSON.parse(text).timeoutSeconds) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a single-orchestrator run's orchestrator message may be coalesced
 * into the run's running delivery: dropped, and covered by that delivery's
 * re-run, which reads the run's log. Every producer commits what such a
 * message is for (a step outcome, a `hook_received`, a cancellation) before
 * it sends it. A `run.wakeUp()` message (`completeWaits`) names waits the
 * log does not: coalesced, it would be lost and the waits would run their
 * full length. The World contract allows that, and world-vercel and
 * world-postgres do it, but world-local delivers it after the running
 * delivery instead, so `@workflow/vitest`'s `waitForSleep()` then
 * `wakeUp()` does not race the delivery that created the wait. A start message (`runInput`) carries the input of a run that
 * may not exist yet, a legacy resume (`hookInput`) carries a payload the
 * orchestrator still has to write, a restart's recovery message
 * (`recovery: true`) asks its delivery to re-send what died with the
 * in-memory queue, and an invocation (`invoke`) waits for its own answer, so
 * those are never coalesced.
 */
function isCoalescible(message: Record<string, unknown>): boolean {
  return !(
    'runInput' in message ||
    'hookInput' in message ||
    (Array.isArray(message.completeWaits) &&
      message.completeWaits.length > 0) ||
    message.recovery === true ||
    message.invoke
  );
}

/** A hook wake's resume timing, to carry to the re-run that covers it. */
function resumeOf(
  message: Record<string, unknown>
): CoalescedResume | undefined {
  if (message.hookResumeTiming === undefined) return undefined;
  return {
    hookResumeTiming: message.hookResumeTiming,
    ...(message.traceCarrier !== undefined && {
      traceCarrier: message.traceCarrier,
    }),
  };
}

/**
 * The key a queue sends when no World gave it one (a queue created on its
 * own, as unit tests do): the in-memory key of `@workflow/utils`, which the
 * runtime checks when no World registered a key source.
 */
const inMemoryQueueAuthKey: QueueAuthKey = {
  current: async () => getQueueAuthKey(),
  reload: async () => getQueueAuthKey(),
  restore: async () => {},
  written: async () => {},
};

export function createQueue(
  config: Partial<Config>,
  options: {
    /** The app's queue auth key, from `createWorld` (see `queue-auth-key.ts`). */
    queueAuthKey?: QueueAuthKey;
    /**
     * The spec version a run records, or `undefined` when it cannot be read.
     * Read for an orchestrator message that carries none (see
     * `Config.readUnstampedRunSpec`); omitted, such a message is not gated.
     */
    runSpecVersion?: (runId: string) => Promise<number | undefined>;
    /**
     * Marked while a single-orchestrator run's orchestrator message that
     * cannot be coalesced waits behind a running delivery of its run, which
     * may be lingering on the live feed with nothing left to run. Both the
     * sending gate and the handler's gate (a message from another process)
     * mark it.
     */
    blockedRuns?: BlockedRuns;
  } = {}
): LocalQueue {
  const queueAuthKey = options.queueAuthKey ?? inMemoryQueueAuthKey;
  /**
   * The message as the World gates it: an orchestrator message without a
   * spec stamp (an older SDK's `resumeHook()` or `cancel()`, another client of
   * the World) is stamped with its run's stored version when that is spec 9
   * or later, so it is serialized with the run's other orchestrator
   * deliveries instead of running beside the live one. Only unstamped
   * messages pay the read; every message this runtime sends is stamped.
   */
  const stampFromRun = async (message: unknown): Promise<unknown> => {
    if (!options.runSpecVersion) return message;
    if (messageRunSpecVersion(message) !== undefined) return message;
    const runId = orchestratorRunIdOf(message);
    if (runId === undefined) return message;
    const specVersion = await options.runSpecVersion(runId);
    return specVersion !== undefined &&
      specVersion >= SPEC_VERSION_SINGLE_ORCHESTRATOR
      ? { ...(message as Record<string, unknown>), runSpecVersion: specVersion }
      : message;
  };
  // Exactly one of these is built, and close() shuts down whichever it is.
  // Resolved once per queue rather than per delivery so a single queue never
  // mixes transports mid-flight.
  const agentOptions = getQueueAgentOptions();
  const nodeHttpAgents = isNodeHttpEnabled()
    ? createNodeHttpAgents({
        maxSockets: agentOptions.connections,
        keepAliveMs: agentOptions.keepAliveTimeout,
      })
    : undefined;
  const httpAgent = nodeHttpAgents ? undefined : new Agent(agentOptions);
  const transport = new TypedJsonTransport();
  const generateId = monotonicFactory();
  const semaphore = new Sema(LOCAL_QUEUE_CONCURRENCY);
  // A single-orchestrator run's (spec >= 9) orchestrator deliveries go one at
  // a time, like a concurrency key on Vercel Queues: the single-writer
  // guarantee's queue half (the in-band fence is the other). Step messages,
  // health checks and earlier runs' messages are not gated (see
  // `singleOrchestratorRunIdOf`), so a run's steps keep running in parallel
  // with each other and with its orchestrator.
  // Orchestrator messages that queue behind a running delivery of their run
  // are coalesced into it: the holder takes them when its handler answers
  // and runs it again, as world-vercel's concurrency key does (see
  // `createOrchestratorGate`).
  const runGate = createOrchestratorGate();
  // The same gate on the receiving side, held by `createQueueHandler` around
  // the handler. `runGate` only sees the messages this process's queue sends,
  // but a run's messages can come from several processes on one data
  // directory (an app, plus a script or test process that calls `start()` or
  // `resumeHook()`), and all of them reach the handler of the process that
  // serves the workflow routes. Separate from `runGate`, which a sender holds
  // while it delivers to its own process's handler.
  const handlerRunGate = createRunGate();
  /** Marks a message's run blocked (see `options.blockedRuns`). */
  const blockRun = (message: unknown): (() => void) | undefined => {
    const runId = singleOrchestratorRunIdOf(message);
    return runId === undefined ? undefined : options.blockedRuns?.block(runId);
  };
  // One line for the first queue auth refusal, then at most one a minute
  // with a count, however many messages are refused.
  const logAuthRefusal = createLogLimiter();

  // Aborted by close(): cancels every pending sleep (delayed deliveries,
  // timeoutSeconds re-deliveries, retry backoffs) so shutdown isn't held
  // hostage by a timer and no delivery is attempted against the closed
  // agent. The resulting AbortError is silently dropped by the
  // isAbortError check in the delivery catch handler.
  const closeController = new AbortController();
  const closeSignal = closeController.signal;
  /**
   * The first delivery attempt of each message sent without a delay, until
   * the attempt has an answer (or has failed). close() waits for them (see
   * CLOSE_RUN_MESSAGE_WAIT_MS) before it aborts: a short-lived sender (the
   * CLI's `wf start`, a script) closes its World right after `start()`
   * returns, and aborting a first attempt that has not reached the app yet
   * loses the message (the queue is in memory), leaving the new run pending.
   */
  const firstAttempts = new Set<FirstAttempt>();
  let closing: Promise<void> | undefined;
  /** The run's `seq`, or undefined when it cannot be read (no run, no data directory). */
  const runSeq = (runId: string): number | undefined => {
    if (!config.dataDir) return undefined;
    try {
      return databaseFor(config.dataDir).get<{ seq: number }>(
        'SELECT seq FROM runs WHERE run_id = ?',
        runId
      )?.seq;
    } catch {
      return undefined;
    }
  };

  /**
   * holds inflight messages by idempotency key to ensure
   * that we don't queue the same message multiple times
   */
  const inflightMessages = new Map<string, MessageId>();
  /** Direct in-process handlers by queue prefix, bypassing HTTP when set. */
  const directHandlers = new Map<string, DirectHandler>();
  /**
   * HTTP delivery routes by queue prefix. A prefix without one is delivered
   * to the Workflow SDK's flow route. Read on every delivery attempt, so a
   * route registered after a message was enqueued (a consumer whose module
   * loads after `start()` re-enqueued its runs) takes the next attempt.
   */
  const routes = new Map<string, string>();
  const deliveryUrl = (baseUrl: string, prefix: string) => {
    const route = routes.get(prefix);
    return route
      ? createAppRouteUrl(baseUrl, route)
      : createWorkflowUrl(baseUrl, { type: 'flow' });
  };

  /**
   * The body of a coalesced re-run: the delivery's own message, with the
   * resume timing (and trace context) of a hook wake it absorbed in place of
   * its own. The runtime starts a resume's latency measurement only from the
   * `hookResumeTiming` of the message it handles, and the re-run is what
   * consumes the absorbed resume. Its own timing is dropped either way: the
   * first run consumed it, and a re-run must not report that resume again.
   */
  const rerunBody = (
    message: unknown,
    resume: CoalescedResume | undefined
  ): Uint8Array => {
    const { hookResumeTiming: _consumed, ...rest } = message as Record<
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
    );
  };

  const queue: Queue['queue'] = async (queueName, sentMessage, opts) => {
    const cleanup = [] as (() => void)[];
    const message = await stampFromRun(sentMessage);

    if (opts?.idempotencyKey) {
      const existing = inflightMessages.get(opts.idempotencyKey);
      if (existing) {
        return { messageId: existing };
      }
    }

    const body = transport.serialize(message);
    const { prefix } = parseQueueName(queueName);
    // A caller's headers never carry the auth header: only the send loop
    // below sets it. Dropped case-insensitively, since a differently cased
    // copy would be merged into the one the loop sets.
    const callerHeaders = Object.fromEntries(
      Object.entries(opts?.headers ?? {}).filter(([name]) => {
        const lower = name.toLowerCase();
        return (
          lower !== QUEUE_AUTH_HEADER && lower !== INVOCATION_STARTED_AT_HEADER
        );
      })
    );
    const messageId = MessageId.parse(`msg_${generateId()}`);
    // One message for its whole life: every delivery below, including the
    // `{ timeoutSeconds }` redeliveries, reuses this id and creation time.
    const createdAt = new Date().toISOString();

    // Extract identifiers from the message for structured logging.
    // Combined workflow messages carry `runId` and may include `stepId`.
    const msg = message as Record<string, unknown>;
    const runId = (msg.runId ?? undefined) as string | undefined;
    const stepId = (msg.stepId ?? undefined) as string | undefined;
    // Keyed by prefix as well, so a run id never gates deliveries on another
    // prefix (a queue consumer of its own, or another namespace).
    const orchestratorRunKey = (() => {
      const id = singleOrchestratorRunIdOf(message);
      return id === undefined ? undefined : `${prefix}${id}`;
    })();
    // On a single-orchestrator run, `{ timeoutSeconds: 0 }` is a handoff: the
    // redelivery starts at once and the handed-off delivery is not an attempt.
    const handsOff = isSingleOrchestratorMessage(message);
    const fields = message as Record<string, unknown>;
    // Whether this message may be coalesced into its run's running delivery,
    // and whether its own delivery covers messages coalesced into it with
    // re-runs. An invocation waits for its own answer, so it does neither.
    const coalescible =
      orchestratorRunKey !== undefined && isCoalescible(fields);
    const rerunsCoalesced =
      orchestratorRunKey !== undefined && fields.invoke !== true;

    if (opts?.idempotencyKey) {
      const key = opts.idempotencyKey;
      inflightMessages.set(key, messageId);
      cleanup.push(() => {
        inflightMessages.delete(key);
      });
    }

    let firstAttemptDone = () => {};
    if (!(opts?.delaySeconds && opts.delaySeconds > 0)) {
      let resolve = () => {};
      const attempt: FirstAttempt = {
        done: new Promise<void>((done) => {
          resolve = done;
        }),
        runId,
        seqAtSend: runId === undefined ? undefined : runSeq(runId),
      };
      firstAttempts.add(attempt);
      firstAttemptDone = () => {
        firstAttempts.delete(attempt);
        resolve();
      };
    }

    (async () => {
      // Honor the caller's requested delivery delay before acquiring a queue
      // slot. Sleeping outside the semaphore so a delayed message doesn't
      // hold a worker hostage for its delay window: the worker should be
      // free to process other (immediate) messages until this one is ready.
      // VQS-side queues honor delaySeconds at the broker, so this brings
      // world-local in line with production behavior.
      if (opts?.delaySeconds && opts.delaySeconds > 0) {
        const delayMs = Math.min(opts.delaySeconds * 1000, MAX_SAFE_TIMEOUT_MS);
        await setTimeout(delayMs, undefined, { signal: closeSignal });
      }

      /**
       * Takes this message's delivery slots: its run's orchestrator gate
       * first (when it is an orchestrator delivery), then a worker slot. The
       * gate is taken first so a delivery waiting for its run holds no worker
       * slot. Both are held for one delivery attempt only and released before
       * any sleep (a `{ timeoutSeconds }` redelivery delay, a retry backoff),
       * because a message that is not being delivered occupies neither, as on
       * Vercel Queues.
       */
      const acquireDelivery = async (): Promise<
        { release: () => void; lease?: OrchestratorLease } | 'coalesced'
      > => {
        let lease: OrchestratorLease | undefined;
        if (orchestratorRunKey) {
          const unblock =
            !coalescible && runGate.isHeld(orchestratorRunKey)
              ? blockRun(message)
              : undefined;
          try {
            lease = await runGate.acquire(orchestratorRunKey, {
              coalescible,
              resume: resumeOf(fields),
            });
          } finally {
            unblock?.();
          }
          if (!lease) return 'coalesced';
        }
        if (!semaphore.tryAcquire()) {
          // Debug-gated: this is the semaphore doing its job. A fan-out wider
          // than the limit queues behind it and every message still runs, so
          // a per-message warning turns a healthy wide run into a wall of
          // output.
          debugLog(
            `[world-local]: concurrency limit (${LOCAL_QUEUE_CONCURRENCY}) reached, waiting for queue to free up`
          );
          await semaphore.acquire();
        }
        return {
          release: () => {
            semaphore.release();
            lease?.release();
          },
          ...(lease && { lease }),
        };
      };
      // Handoffs counted as such per message, as Vercel Queues bounds them;
      // past it a handoff counts toward `attempt` and the safety limit.
      const MAX_LOCAL_HANDOFFS = 10_000;
      // Number of times the message has actually reached a handler (returned
      // ok, a timeoutSeconds re-delivery, or an HTTP error response). This,
      // not the loop counter, is the attempt the handler sees via
      // `x-vqs-message-attempt`, which it counts against MAX_QUEUE_DELIVERIES.
      // Failures before response headers do not advance this; body failures do,
      // because the handler has already accepted that delivery.
      let delivery = 0;
      // Deliveries that ended in a handoff, which `attempt` and the safety
      // limit leave out.
      let handoffs = 0;
      // Deliveries whose handler answered with an error.
      let failedDeliveries = 0;
      // Deliveries the runtime refused as unauthenticated (see
      // `MAX_QUEUE_AUTH_REFUSALS`).
      let authRefusals = 0;
      // Refusals fixed by a new key, retried at once (see
      // `MAX_UNCOUNTED_KEY_ROTATIONS`).
      let keyRotations = 0;
      // Coalesced re-runs, which, like handoffs, `attempt` and the safety
      // limit leave out (a re-run is not a delivery of the queue).
      let reruns = 0;
      // Re-runs within the current hold of the run's gate.
      let rerunsThisHold = 0;
      // The body each delivery sends: the message, or for a re-run the
      // message with the resume timing of a hook wake it absorbed
      // (`rerunBody`), kept for the deliveries after it.
      let deliveryBody: Uint8Array = body;
      // When the current hold of the run's gate began (see
      // `INVOCATION_STARTED_AT_HEADER`).
      let holdStartedAt = 0;
      let releaseDelivery: (() => void) | undefined;
      let lease: OrchestratorLease | undefined;
      const endDelivery = () => {
        releaseDelivery?.();
        releaseDelivery = undefined;
        lease = undefined;
      };
      try {
        for (
          let loop = 0;
          loop - handoffs - reruns < MAX_LOCAL_SAFETY_LIMIT;
          loop++
        ) {
          // Still held for a coalesced re-run or a handoff; else take it.
          if (!releaseDelivery) {
            const acquired = await acquireDelivery();
            if (acquired === 'coalesced') return;
            releaseDelivery = acquired.release;
            lease = acquired.lease;
            rerunsThisHold = 0;
            holdStartedAt = Date.now();
          }
          if (closeSignal.aborted) return;
          // The app's key, which the runtime checks before the handler does
          // any work (`queueAuthMode: 'loopback'`). Cached: no file read per
          // delivery. Attached on every attempt and both transports, so
          // health checks and in-process deliveries carry it too. A reader
          // with no key file yet sends none, and is refused.
          const sentKey = await queueAuthKey.current();
          const headers: Record<string, string> = {
            ...callerHeaders,
            'content-type': 'application/json',
            ...(sentKey !== undefined && { [QUEUE_AUTH_HEADER]: sentKey }),
            'x-vqs-queue-name': queueName,
            'x-vqs-message-id': messageId,
            'x-vqs-message-attempt': String(delivery + 1 - handoffs - reruns),
            'x-vqs-message-delivery-count': String(delivery + 1),
            'x-vqs-message-created-at': createdAt,
            ...(orchestratorRunKey && {
              [INVOCATION_STARTED_AT_HEADER]: String(holdStartedAt),
            }),
          };
          const directHandler = directHandlers.get(prefix);
          let response: Response;
          let text: string;

          try {
            if (directHandler) {
              const req = new Request(
                deliveryUrl(resolveDirectBaseUrl(config), prefix),
                { method: 'POST', headers, body: deliveryBody }
              );
              response = await directHandler(req);
            } else {
              const baseUrl = await resolveBaseUrl(config);
              const url = deliveryUrl(baseUrl, prefix);
              response = nodeHttpAgents
                ? await nodeHttpFetch(url, {
                    method: 'POST',
                    headers: new Headers(headers),
                    body: deliveryBody,
                    agents: nodeHttpAgents,
                    signal: closeSignal,
                    headersTimeoutMs: agentOptions.headersTimeout,
                    bodyTimeoutMs: agentOptions.bodyTimeout,
                  })
                : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici v7 dispatcher types don't match @types/node's RequestInit
                  await fetch(url, {
                    method: 'POST',
                    duplex: 'half',
                    dispatcher: httpAgent,
                    headers,
                    body: deliveryBody,
                    signal: closeSignal,
                  } as any);
            }
            firstAttemptDone();
            delivery++;
            text = await response.text();
          } catch (err) {
            firstAttemptDone();
            endDelivery();
            // A transport can fail before response headers or while consuming
            // the body. Both are transient: back off and retry the same
            // durable message rather than leaving its run stalled. Two
            // failures are not retryable:
            //  - shutdown: close() aborted the agent / the backoff sleep.
            //  - a detached-ArrayBuffer proxy misconfig, which never succeeds:
            //    rethrow so the outer catch surfaces the actionable guidance.
            const name = (err as { name?: string } | undefined)?.name;
            if (
              closeSignal.aborted ||
              name === 'AbortError' ||
              name === 'ResponseAborted'
            ) {
              return;
            }
            if (isDetachedArrayBufferQueueError(err)) throw err;

            console.error(
              `[world-local] Queue delivery failed at the transport (loop ${loop + 1}), retrying`,
              {
                queueName,
                messageId,
                ...(runId && { runId }),
                ...(stepId && { stepId }),
                error: String(err),
              }
            );
            await setTimeout(5000, undefined, { signal: closeSignal });
            continue;
          }

          // An acknowledged delivery covers the run's orchestrator messages
          // that queued behind it, with a re-run while it still holds the
          // gate (and its worker slot). Past the cap they are delivered as
          // usual once it releases.
          if (
            response.ok &&
            lease &&
            rerunsCoalesced &&
            rerunsThisHold < MAX_LOCAL_COALESCED_RERUNS &&
            isAcknowledgement(text)
          ) {
            const taken = lease.takeWaiting();
            if (taken.count > 0) {
              reruns++;
              rerunsThisHold++;
              deliveryBody = rerunBody(message, taken.resume);
              continue;
            }
          }
          // A spec 9 handoff (`{ timeoutSeconds: 0 }`) is delivered again at
          // once, before the run's orchestrator messages that queued behind
          // it: it keeps the run's gate, as a new invocation (a fresh
          // `invocationStartedAt` and re-run budget). That delivery reads the
          // log, so it also covers the coalescible messages waiting behind
          // it, and carries the resume timing of a hook wake among them: it
          // is the delivery that consumes that resume. Without the gate (a
          // message no gate holds) it is simply redelivered.
          if (
            response.ok &&
            handsOff &&
            handoffs < MAX_LOCAL_HANDOFFS &&
            isHandoff(text)
          ) {
            handoffs++;
            if (lease) {
              holdStartedAt = Date.now();
              rerunsThisHold = 0;
              if (rerunsCoalesced) {
                const taken = lease.takeWaiting();
                if (taken.resume) {
                  deliveryBody = rerunBody(message, taken.resume);
                }
              }
            } else {
              endDelivery();
            }
            continue;
          }
          endDelivery();
          if (response.ok) {
            try {
              const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
              if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
                // Clamp to MAX_SAFE_TIMEOUT_MS to avoid Node.js setTimeout overflow warning.
                // When this fires early, the handler recalculates remaining time from
                // persistent state and returns another timeoutSeconds if needed.
                if (timeoutSeconds > 0) {
                  const timeoutMs = Math.min(
                    timeoutSeconds * 1000,
                    MAX_SAFE_TIMEOUT_MS
                  );
                  await setTimeout(timeoutMs, undefined, {
                    signal: closeSignal,
                  });
                } else if (handsOff && handoffs < MAX_LOCAL_HANDOFFS) {
                  handoffs++;
                }
                continue;
              }
            } catch {}
            return;
          }

          if (isQueueAuthRefusal(response)) {
            // The runtime's own queue auth refusal (marked, unlike a proxy's
            // bare 401): the route holds a key other than the one sent.
            // Another process of the app may have written a new key (the app
            // restarted, a script called `start()`), so re-read the key file
            // and, if it changed, retry at once with the new key. That
            // refusal is not counted: the key rotated, which one of the
            // app's processes does when it starts. Past
            // MAX_UNCOUNTED_KEY_ROTATIONS such retries the key is changing
            // on every attempt, and the refusal counts like any other, so
            // the message cannot spin.
            // Otherwise (the key did not change, or the uncounted rotations
            // are used up) count it and retry a few
            // times with the short backoff (the route re-reads the file on a
            // mismatch too, rate-limited), then give the message up rather
            // than retry it for hours. Retrying is safe: a refused delivery
            // reached no handler and touched no run, so it is not counted as
            // an attempt either. A given-up message's run is left as it is.
            delivery--;
            const reloadedKey = await queueAuthKey.reload();
            if (
              reloadedKey !== undefined &&
              reloadedKey !== sentKey &&
              keyRotations < MAX_UNCOUNTED_KEY_ROTATIONS
            ) {
              keyRotations++;
              debugLog(
                '[world-local]: delivery refused as unauthenticated; the queue auth key changed, retrying with it'
              );
              continue;
            }
            authRefusals++;
            if (authRefusals < MAX_QUEUE_AUTH_REFUSALS) {
              debugLog(
                `[world-local]: delivery refused as unauthenticated (${authRefusals}/${MAX_QUEUE_AUTH_REFUSALS}), retrying`
              );
              await setTimeout(localRetryDelayMs(authRefusals), undefined, {
                signal: closeSignal,
              });
              continue;
            }
            logAuthRefusal((refusedSinceLastLog) => {
              console.error(
                `[world-local] Queue delivery refused by the app as unauthenticated ${MAX_QUEUE_AUTH_REFUSALS} times; giving up the message`,
                {
                  queueName,
                  messageId,
                  ...(runId && { runId }),
                  ...(stepId && { stepId }),
                  refusedSinceLastLog,
                  hint: QUEUE_AUTH_REFUSAL_HINT,
                }
              );
            });
            return;
          }

          console.error(
            `[world-local] Queue message failed (attempt ${delivery}, HTTP ${response.status})`,
            {
              queueName,
              messageId,
              ...(runId && { runId }),
              ...(stepId && { stepId }),
              handlerError: text,
              ...(response.status === 401 && {
                hint:
                  'A 401 without the Workflow runtime’s refusal marker, so not a queue auth ' +
                  'refusal (perhaps a proxy or auth layer in front of the app). Retrying.',
              }),
              ...(!directHandler &&
                !routes.has(prefix) &&
                (response.status === 400 || response.status === 404) && {
                  hint:
                    `No route or handler is registered for queue prefix "${prefix}", ` +
                    `so its messages go to the Workflow SDK's flow route (${WORKFLOW_FLOW_ROUTE}). ` +
                    `A queue consumer of its own registers one with world.registerRoute(prefix, path) or world.registerHandler(prefix, handler).`,
                }),
            }
          );

          // Backs off as VQS does (see `localRetryDelayMs`).
          failedDeliveries++;
          await setTimeout(localRetryDelayMs(failedDeliveries), undefined, {
            signal: closeSignal,
          });
        }

        console.error(
          `[world-local] Queue message exhausted safety limit (${MAX_LOCAL_SAFETY_LIMIT} attempts)`,
          {
            queueName,
            messageId,
            ...(runId && { runId }),
            ...(stepId && { stepId }),
          }
        );
      } finally {
        firstAttemptDone();
        endDelivery();
      }
    })()
      .catch((err) => {
        // Silently ignore client disconnect errors (e.g., browser refresh during streaming)
        // These are expected and should not cause unhandled rejection warnings
        const isAbortError =
          err?.name === 'AbortError' || err?.name === 'ResponseAborted';
        if (!isAbortError) {
          if (isDetachedArrayBufferQueueError(err)) {
            console.error(
              `[local world] Queue operation failed: detected "${DETACHED_ARRAYBUFFER_ERROR}". ` +
                "This usually means a Next.js proxy/middleware consumed Workflow's internal " +
                'request before the executor could read it. Exclude `/.well-known/workflow/*` ' +
                `from your matcher. See ${PROXY_HANDLER_DOCS_URL}`,
              {
                queueName,
                messageId,
                ...(runId && { runId }),
                ...(stepId && { stepId }),
                originalError: err,
              }
            );
          } else {
            console.error('[local world] Queue operation failed:', err);
          }
        }
      })
      .finally(() => {
        for (const fn of cleanup) {
          fn();
        }
      });

    return { messageId };
  };

  const HeaderParser = z.object({
    'x-vqs-queue-name': ValidQueueName,
    'x-vqs-message-id': MessageId,
    'x-vqs-message-attempt': z.coerce.number(),
    // Sent by world-postgres, whose `attempt` restarts on a reschedule.
    'x-vqs-message-delivery-count': z.coerce
      .number()
      .int()
      .positive()
      .optional(),
    // Absent on a delivery from a sender that predates it.
    'x-vqs-message-created-at': z.iso.datetime().optional(),
    // See `INVOCATION_STARTED_AT_HEADER`; absent from an older sender.
    [INVOCATION_STARTED_AT_HEADER]: z.coerce
      .number()
      .int()
      .positive()
      .optional(),
  });

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    return async (req) => {
      const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));

      if (!headers.success || !req.body) {
        return Response.json(
          {
            error: !req.body
              ? 'Missing request body'
              : 'Missing required headers',
          },
          { status: 400 }
        );
      }

      const queueName = headers.data['x-vqs-queue-name'];
      const messageId = headers.data['x-vqs-message-id'];
      const attempt = headers.data['x-vqs-message-attempt'];
      const deliveryCountHeader = headers.data['x-vqs-message-delivery-count'];
      const createdAtHeader = headers.data['x-vqs-message-created-at'];

      if (!queueName.startsWith(prefix)) {
        return Response.json(
          {
            error: 'Unhandled queue',
            detail: `This route handles queue prefix "${prefix}", not "${queueName}".`,
          },
          { status: 400 }
        );
      }

      // A message from another process (a script, an older SDK) reaches only
      // this gate, so an unstamped one is resolved from its run here too.
      const body = await stampFromRun(
        await new TypedJsonTransport().deserialize(req.body)
      );
      const invocationStartedAt = headers.data[INVOCATION_STARTED_AT_HEADER];
      const orchestratorRunId = singleOrchestratorRunIdOf(body);
      let releaseRun: (() => void) | undefined;
      if (orchestratorRunId !== undefined) {
        const key = `${prefix}${orchestratorRunId}`;
        // A message from another process waits here, not at `runGate`.
        const unblock =
          handlerRunGate.isHeld(key) &&
          !isCoalescible(body as Record<string, unknown>)
            ? blockRun(body)
            : undefined;
        try {
          releaseRun = await handlerRunGate.acquire(key);
        } finally {
          unblock?.();
        }
      }
      try {
        const result = await handler(body, {
          attempt,
          // Counts every delivery of this message that reached a handler,
          // starting at 1, including `{ timeoutSeconds }` redeliveries.
          deliveryCount: deliveryCountHeader ?? attempt,
          ...(createdAtHeader ? { createdAt: new Date(createdAtHeader) } : {}),
          ...(invocationStartedAt !== undefined && { invocationStartedAt }),
          queueName,
          messageId,
        });

        if (
          typeof body === 'object' &&
          body !== null &&
          'invoke' in body &&
          body.invoke === true
        ) {
          return Response.json({ result });
        }

        let timeoutSeconds: number | null = null;
        if (
          typeof result === 'object' &&
          result !== null &&
          'timeoutSeconds' in result &&
          typeof result.timeoutSeconds === 'number'
        ) {
          timeoutSeconds = Math.min(
            result.timeoutSeconds,
            LOCAL_QUEUE_MAX_VISIBILITY
          );
        }

        if (timeoutSeconds != null) {
          return Response.json({ timeoutSeconds });
        }

        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      } finally {
        releaseRun?.();
      }
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    const packageInfo = await getPackageInfo();
    return `dpl_local@${packageInfo.version}`;
  };

  return {
    // Every delivery carries the app's key from the data directory (see the
    // send loop), and the runtime refuses one that does not.
    queueAuthMode: 'loopback',
    queue,
    createQueueHandler,
    getDeploymentId,
    registerHandler(prefix: QueuePrefix, handler: DirectHandler) {
      directHandlers.set(prefix, handler);
    },
    registerRoute(prefix: QueuePrefix, path: string) {
      routes.set(QueuePrefix.parse(prefix), parseQueueRoute(path));
    },
    close() {
      // Idempotent: shutdown paths (CLI signal handlers, test teardown)
      // may close the queue more than once.
      closing ??= (async () => {
        const started = Date.now();
        // Still to reach the app: unanswered, and (for a message for a run)
        // the app has not written to its run since it was sent.
        const unreached = () =>
          [...firstAttempts].filter((attempt) => {
            const elapsed = Date.now() - started;
            if (
              attempt.seqAtSend === undefined ||
              attempt.runId === undefined
            ) {
              return elapsed < CLOSE_FIRST_ATTEMPT_WAIT_MS;
            }
            if (elapsed >= CLOSE_RUN_MESSAGE_WAIT_MS) return false;
            const seq = runSeq(attempt.runId);
            return seq === undefined || seq <= attempt.seqAtSend;
          });
        for (let open = unreached(); open.length > 0; open = unreached()) {
          let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled(open.map((attempt) => attempt.done)),
            new Promise<void>((resolve) => {
              timer = globalThis.setTimeout(resolve, CLOSE_POLL_MS);
              timer.unref?.();
            }),
          ]);
          globalThis.clearTimeout(timer);
        }
        closeController.abort();
        if (nodeHttpAgents) destroyNodeHttpAgents(nodeHttpAgents);
        await httpAgent?.close();
      })();
      return closing;
    },
  };
}
