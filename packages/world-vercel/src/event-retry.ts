/**
 * In-process retry for event POSTs.
 *
 * undici's `RetryAgent` never retries a POST (a non-idempotent method), so a
 * trivially-recoverable transport blip (`UND_ERR_REQ_RETRY`, `ECONNRESET`, a
 * socket/headers timeout, a transient 5xx) bubbles straight out of an event
 * write. For a `step_completed`/`step_failed` write that means the queue message
 * is not acked, it redelivers, the workflow replays, and the step's user code is
 * re-executed with `attempt++` even though it already ran to completion once.
 *
 * That re-execution is avoidable, because workflow-server makes event writes
 * idempotent *in outcome*: the entity handlers run before the event-log row is
 * inserted, and state transitions are conditional writes that exclude
 * already-terminal states. A retry whose original already landed therefore
 * throws before any row is written and surfaces as a 409 for most types, which
 * the SDK maps to `EntityConflictError` and existing callers already handle (e.g.
 * the step executor swallows it as `{ type: 'skipped' }`). The two non-conflict
 * cases still resolve as plain success the caller already handles: `run_started`
 * early-returns the running run and `attr_set` replays the existing event (both
 * 200). So retrying the POST is safe: worst case we observe the outcome our own
 * first attempt caused.
 *
 * This module retries the POST in-process for the event types that are provably
 * idempotent-on-retry, and leaves the rest at a single attempt. The three
 * excluded types are NOT safe to blindly retry:
 *
 *   - `step_started`:  its handler does an unconditional `attempt += 1` with a
 *                       `.where()` that only excludes terminal states, so a
 *                       retried start double-increments the attempt counter.
 *   - `step_retrying`: re-applies `pending` (idempotent state) but its handler
 *                       does NOT throw on a duplicate, so a retry appends a
 *                       second event-log row.
 *   - `hook_received`: an ORDINARY hook write has no server-side guard, so a
 *                       retry appends a duplicate row and can re-deliver the
 *                       payload. The atomic lazy-resume shape (resumeId +
 *                       resumePayloadDigest) IS guarded (the server's
 *                       (runId, resumeId) claim converges a retry on the same
 *                       canonical event), so those writes opt back into the
 *                       standard policy via
 *                       {@link EventPostRetryOptions.idempotentHookResume}.
 *
 * Only transient/ambiguous transport failures are retried under that
 * eligibility matrix; definitive responses (409/410/425 and any other 4xx)
 * surface immediately, exactly as before.
 *
 * A 429 (`ThrottleError`) is handled by a separate in-process policy that
 * applies to EVERY event type: a genuine application 429 means the server
 * rejected the write outright (nothing landed), so none of the duplicate-row /
 * attempt-double-count hazards above apply (the same definitive-no-write
 * reasoning `STREAM_RETRY_OPTIONS` uses to retry 429 on stream PUTs). Firewall
 * challenges never reach here as `ThrottleError`: `errorForResponse` maps a
 * 429 + `x-vercel-mitigated: challenge` to a transport `WorkflowWorldError`
 * instead (see isFirewallChallenge429), so throttle retries cannot hot-loop
 * against the firewall. Each retry honors the server's `retryAfter`, and the
 * cumulative wait is capped by THROTTLE_RETRY_BUDGET_MS; beyond that the
 * ThrottleError surfaces and the queue's redelivery takes over, exactly as
 * before this policy existed.
 *
 * This is the *only* retry loop on the event-write path, for both transports.
 * The WebSocket transport raises `code: 'TRANSPORT'` (the shape `utils.ts`
 * produces for a failed `fetch`), so it lands here rather than carrying a
 * second policy blind to `EVENT_RETRY_ELIGIBILITY`.
 */

import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { EventTypeSchema } from '@workflow/world';
import type { z } from 'zod';

/** Keeps caller-owned observer failures out of transport retry/classification. */
export class EventObserverError extends Error {
  constructor(readonly error: unknown) {
    super('Event observer failed', { cause: error });
    this.name = 'EventObserverError';
  }
}

/** Every event type the world knows about (includes the server-only
 * `hook_conflict`, which the SDK never POSTs). */
type WorkflowEventType = z.infer<typeof EventTypeSchema>;

export interface EventRetryPolicy {
  /** Whether a failed POST of this event type may be retried in-process. */
  retryable: boolean;
  /** Why, kept in code so the validated classification is self-documenting. */
  reason: string;
}

/**
 * Validated per-event idempotency-on-retry classification, derived from reading
 * every handler in workflow-server's event create path. `retryable: true` means
 * a retry whose original already landed produces no duplicate event row and no
 * double-applied state (it surfaces a 409 the SDK already handles).
 *
 * Declared `satisfies Record<WorkflowEventType, …>` so adding or removing a
 * world event type without classifying it is a compile error.
 */
export const EVENT_RETRY_ELIGIBILITY = {
  // Creates: conditional create → 409 EntityConflictError if it already exists.
  run_created: {
    retryable: true,
    reason: 'conditional create → 409 if exists',
  },
  step_created: {
    retryable: true,
    reason: 'conditional create → 409 if exists',
  },
  wait_created: {
    retryable: true,
    reason: 'conditional create → 409 if exists',
  },
  hook_created: {
    retryable: true,
    reason: 'transactional token uniqueness → 409 if exists',
  },
  // Run start: early-returns if already running, writes no duplicate row.
  run_started: {
    retryable: true,
    reason: 'early-returns if already running, no duplicate row',
  },
  // Terminal transitions: conditional `.where()` excludes terminal states →
  // 409 before the event row is written.
  run_completed: {
    retryable: true,
    reason: 'terminal-state guard → 409, no duplicate row',
  },
  run_failed: {
    retryable: true,
    reason: 'terminal-state guard → 409, no duplicate row',
  },
  run_cancelled: {
    retryable: true,
    reason: 'terminal-state guard → 409, no duplicate row',
  },
  step_completed: {
    retryable: true,
    reason: 'terminal-state guard → 409, no duplicate row',
  },
  step_failed: {
    retryable: true,
    reason: 'terminal-state guard → 409, no duplicate row',
  },
  wait_completed: {
    retryable: true,
    reason: 'waiting-state guard → 409, no duplicate row',
  },
  hook_disposed: {
    retryable: true,
    reason: 'conditional delete (exists) → 409, no duplicate row',
  },
  // True idempotency via a correlationId constraint that reuses the eventId.
  attr_set: {
    retryable: true,
    reason: 'correlationId constraint reuses eventId (idempotent replay)',
  },
  // NOT safe to retry; see the module comment.
  step_started: {
    retryable: false,
    reason: 'unconditional attempt increment → a retry double-counts attempts',
  },
  step_retrying: {
    retryable: false,
    reason: 'no duplicate guard → a retry appends a second event row',
  },
  hook_received: {
    retryable: false,
    reason:
      'no server guard → a retry duplicates the row / re-delivers payload. ' +
      'EXCEPTION: the atomic lazy-resume shape (resumeId + digest) is ' +
      'deduplicated server-side by the (runId, resumeId) claim, so those ' +
      'writes opt in via withEventPostRetry({ idempotentHookResume })',
  },
  // Server-originated; the SDK never POSTs it.
  hook_conflict: {
    retryable: false,
    reason: 'server-originated; never POSTed by the SDK',
  },
  // Server-originated sealed-log filler (specVersion 7); the SDK never
  // POSTs it. The server's read path writes it to seal an abandoned slot.
  noop: {
    retryable: false,
    reason: 'server-originated; never POSTed by the SDK',
  },
} satisfies Record<WorkflowEventType, EventRetryPolicy>;

/** Up to this many retries after the initial attempt (3 attempts total). */
export const MAX_EVENT_POST_RETRIES = 2;

/**
 * Cumulative in-process wait budget for 429 (`ThrottleError`) retries, per
 * event POST. Bounds the "no attempt tracking" failure mode: a server that
 * keeps 429ing cannot pin the invocation: once the budget cannot cover the
 * next `retryAfter`, the ThrottleError surfaces and the queue's (delivery-
 * counted, backed-off) redelivery takes over. Sized so a couple of attempts
 * fit at the Retry-After magnitudes the backend sends under write contention
 * (on the order of ~10s) while staying well inside a flow invocation's
 * duration limit.
 */
export const THROTTLE_RETRY_BUDGET_MS = 30_000;
/** Backoff when a 429 carries no usable Retry-After. */
const DEFAULT_THROTTLE_RETRY_AFTER_SECONDS = 1;
/** Base backoff; doubles per attempt. Kept tiny: the goal is riding out a
 * brief blip inline, not waiting out an outage (that falls through to the
 * queue's redelivery). */
export const EVENT_POST_RETRY_BASE_MS = 100;
const EVENT_POST_RETRY_JITTER_MS = 50;

/** Transient transport error codes/names worth retrying. Mirrors undici's
 * default retryable `errorCodes` plus its timeout/retry codes. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_REQ_RETRY',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  // Names (undici/Node surface these on the error or its cause).
  // `TimeoutError` is our own per-request deadline (`AbortSignal.timeout` in
  // makeRequest), a genuinely ambiguous failure worth retrying. We deliberately
  // do NOT include `AbortError`: that is how an external/caller-supplied
  // cancellation surfaces (makeRequest composes the caller's signal via
  // `AbortSignal.any`), and re-issuing a write the caller asked to cancel
  // (stalling the abort by the full backoff budget) would be wrong.
  'TimeoutError',
  'RequestRetryError',
]);

/** Walk an error and its `cause` chain collecting `code`/`name` markers.
 * `fetch()` (undici) wraps low-level failures in a `TypeError: fetch failed`
 * whose `cause` carries the real `code`, so the chain must be inspected. */
function collectErrorMarkers(err: unknown, depth = 0): string[] {
  if (depth > 5 || err === null || typeof err !== 'object') return [];
  const markers: string[] = [];
  const e = err as { code?: unknown; name?: unknown; cause?: unknown };
  if (typeof e.code === 'string') markers.push(e.code);
  if (typeof e.name === 'string') markers.push(e.name);
  if (e.cause) markers.push(...collectErrorMarkers(e.cause, depth + 1));
  return markers;
}

/**
 * Whether a failed event POST should be retried as a transient failure.
 * Retries transient/ambiguous transport failures and transient 5xx; never
 * retries a definitive response (409/410/425/429 and other 4xx). 429 is not
 * "transient" in this classification: `withEventPostRetry` gives it its own
 * budgeted, Retry-After-honoring policy.
 */
export function isRetryableEventPostError(err: unknown): boolean {
  // Observer code is caller-owned and runs only after a response frame has
  // been validated. Its errors are never evidence of a failed transport, even
  // when the original error happens to carry a retryable-looking code.
  if (err instanceof EventObserverError) return false;

  // Definitive, server-considered outcomes, never retried as *transient*.
  // (425 is left to the runtime's retry-after handling; 429 has its own
  // in-process policy in withEventPostRetry, gated by THROTTLE_RETRY_BUDGET_MS
  // rather than this transient classification.)
  if (
    EntityConflictError.is(err) ||
    RunExpiredError.is(err) ||
    TooEarlyError.is(err) ||
    ThrottleError.is(err)
  ) {
    return false;
  }

  if (WorkflowWorldError.is(err)) {
    // Body parsed past the response but the write may have landed: safe to
    // retry for eligible events (a landed original re-surfaces as 409).
    if (err.code === 'PARSE_ERROR') return true;
    // A transport failure the world layer already classified as transient:
    // `utils.ts` sets this for a `fetch` failing with a
    // `TRANSIENT_TRANSPORT_ERROR_CODES` code, `events-v4.ts` for a WS socket
    // that died, refused a send, produced no correlatable reply or missed its
    // deadline. The frame was never acked in any of them. Keying on the code
    // rather than re-deriving transience from the cause chain is what lets one
    // policy serve both transports; it also collapses a drift, since
    // `UND_ERR_CONNECT`, `UND_ERR_CLOSED` and `EAI_AGAIN` are in utils.ts's set
    // but not in TRANSIENT_CODES below, so they counted as retryable for queue
    // redelivery yet were skipped in-process.
    //
    // `TIMEOUT` is deliberately excluded: utils.ts maps both a missed deadline
    // and a caller's `AbortError` onto that one code, so it must keep falling
    // through to the marker walk, which retries the former and refuses the
    // latter.
    if (err.code === 'TRANSPORT') return true;
    if (typeof err.status === 'number') {
      // Transient server errors; 4xx are definitive and not retried.
      return err.status >= 500 && err.status <= 599;
    }
    // No status (e.g. a timeout wrapped by makeRequest): fall through to the
    // transport-marker check on the error/cause chain.
  }

  return collectErrorMarkers(err).some((m) => TRANSIENT_CODES.has(m));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Gated like the rest of world-vercel's HTTP layer (`DEBUG=workflow:*`). Keeps
 * in-process retries visible during a latency/outage investigation; otherwise a
 * step that quietly rode out a blip and one that exhausted its retries and fell
 * through to queue redelivery look identical in logs/traces. */
const RETRY_DEBUG_ENABLED =
  typeof process !== 'undefined' &&
  typeof process.env.DEBUG === 'string' &&
  (process.env.DEBUG.includes('workflow:') || process.env.DEBUG === '*');

function logRetry(message: string, fields: Record<string, unknown>): void {
  if (!RETRY_DEBUG_ENABLED) return;
  const suffix = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.debug(`[workflow:world-vercel:event-retry] ${message} ${suffix}`);
}

/** A concise identifier for the failure, for the debug line above. */
function errorMarker(err: unknown): string {
  if (WorkflowWorldError.is(err)) {
    return err.code ?? (err.status != null ? `status_${err.status}` : err.name);
  }
  return (
    collectErrorMarkers(err)[0] ?? (err instanceof Error ? err.name : 'unknown')
  );
}

export interface EventPostRetryOptions {
  /**
   * Narrow opt-in for `hook_received` writes carrying the atomic lazy-resume
   * idempotency pair (`resumeId` + `resumePayloadDigest`). Those writes are
   * deduplicated server-side by the `(runId, resumeId)` claim (a retry whose
   * original landed converges on the same canonical event instead of
   * appending a duplicate row), so they get the standard transient retry
   * policy. Legacy `hook_received` (no pair, or an incomplete one) stays
   * single-attempt per {@link EVENT_RETRY_ELIGIBILITY}; definitive 4xx
   * responses stay non-retryable regardless.
   */
  idempotentHookResume?: boolean;
  /**
   * Batch POST retry verdict, set by `createWorkflowRunEventBatch` from the
   * batch's CONTENTS. `true` means every event in the batch converges on a
   * retry of a committed attempt: entity-conditioned events (creates,
   * terminal transitions) re-reject with 409, and a `step_started` is fenced
   * by its born-running pair's create-claim, so the whole POST gets the
   * standard transient retry policy and a re-send converges to per-event
   * 409s with nothing written twice. `false` means at least one event does
   * NOT converge (a standalone bare `step_started` re-increments `attempt`,
   * a `step_retrying` re-patches its step), so the batch runs
   * single-attempt and recovery is left to queue redelivery. When set (a
   * batch call), this verdict REPLACES the per-type matrix entirely: the
   * matrix classifies single posts and its entry for any one type says
   * nothing about a mixed batch. Definitive 4xx responses stay
   * non-retryable regardless.
   */
  batchIdempotent?: boolean;
}

/**
 * Per-POST throttle-wait accounting. The returned function waits out a 429's
 * `retryAfter` in-process (so the caller can re-attempt), or rethrows the
 * ThrottleError once the cumulative wait would exceed
 * THROTTLE_RETRY_BUDGET_MS, at which point the queue's delivery-counted
 * redelivery takes over.
 */
function createThrottleWaiter(
  eventType: WorkflowEventType
): (err: ThrottleError) => Promise<void> {
  let waitedMs = 0;
  return async (err) => {
    const waitMs =
      Math.max(
        1,
        typeof err.retryAfter === 'number'
          ? err.retryAfter
          : DEFAULT_THROTTLE_RETRY_AFTER_SECONDS
      ) * 1000;
    if (waitedMs + waitMs > THROTTLE_RETRY_BUDGET_MS) {
      logRetry('throttle retry budget exhausted; surfacing to the queue', {
        eventType,
        waitedMs,
        retryAfter: err.retryAfter,
      });
      throw err;
    }
    waitedMs += waitMs;
    // Visible (not debug-gated): this stalls the invocation for whole
    // seconds, which would otherwise read as unexplained latency.
    console.warn(
      `[workflow] Throttled (429) writing ${eventType} event; retrying in-process in ${waitMs / 1000}s`
    );
    await sleep(waitMs);
  };
}

/** Whether this event type may retry transient failures in-process, including
 * the narrow `hook_received` lazy-resume opt-in (see EventPostRetryOptions). */
function isEligibleForTransientRetry(
  eventType: WorkflowEventType,
  options?: EventPostRetryOptions
): boolean {
  // A batch call always carries an explicit verdict derived from every event
  // it contains; the per-type matrix (keyed on the batch's FIRST event) must
  // not override it in either direction.
  if (options?.batchIdempotent !== undefined) {
    return options.batchIdempotent;
  }
  return (
    (eventType === 'hook_received' && options?.idempotentHookResume === true) ||
    (EVENT_RETRY_ELIGIBILITY[eventType]?.retryable ?? false)
  );
}

/**
 * Run an event POST, retrying transient transport failures in-process when the
 * event type is idempotent-on-retry, and 429 throttles in-process for every
 * event type (a 429 is a definitive no-write; see the module comment) while
 * the cumulative `retryAfter` wait fits THROTTLE_RETRY_BUDGET_MS. Other
 * definitive responses run/throw on the first attempt, preserving existing
 * behavior.
 */
export async function withEventPostRetry<T>(
  fn: () => Promise<T>,
  eventType: WorkflowEventType,
  options?: EventPostRetryOptions
): Promise<T> {
  const retryable = isEligibleForTransientRetry(eventType, options);
  // Throttle waits draw on a shared per-POST budget instead of the transient
  // attempt counter, so a throttled write keeps its full transient-blip
  // allowance (and vice versa).
  const waitOutThrottle = createThrottleWaiter(eventType);
  for (let attempt = 0; ; ) {
    try {
      return await fn();
    } catch (err) {
      if (ThrottleError.is(err)) {
        await waitOutThrottle(err);
        continue;
      }
      if (!retryable || !isRetryableEventPostError(err)) {
        throw err;
      }
      if (attempt >= MAX_EVENT_POST_RETRIES) {
        // Out of retries on a still-transient failure: surface it so the queue
        // redelivers (the worst-case fallthrough the in-process retry rode
        // against).
        logRetry(
          'exhausted in-process retries; surfacing for queue redelivery',
          {
            eventType,
            attempts: attempt + 1,
            error: errorMarker(err),
          }
        );
        throw err;
      }
      const backoff =
        EVENT_POST_RETRY_BASE_MS * 2 ** attempt +
        Math.floor(Math.random() * EVENT_POST_RETRY_JITTER_MS);
      attempt++;
      logRetry('retrying event POST after transient failure', {
        eventType,
        attempt,
        backoffMs: backoff,
        error: errorMarker(err),
      });
      await sleep(backoff);
    }
  }
}
