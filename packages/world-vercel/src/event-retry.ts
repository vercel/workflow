/**
 * In-process retry for event POSTs.
 *
 * undici's `RetryAgent` never retries a POST (a non-idempotent method), so a
 * trivially-recoverable transport blip — `UND_ERR_REQ_RETRY`, `ECONNRESET`, a
 * socket/headers timeout, a transient 5xx — bubbles straight out of an event
 * write. For a `step_completed`/`step_failed` write that means the queue message
 * is not acked, it redelivers, the workflow replays, and the step's user code is
 * re-executed with `attempt++` even though it already ran to completion once.
 *
 * That re-execution is avoidable, because workflow-server makes event writes
 * idempotent *in outcome*: the entity handlers run before the event-log row is
 * inserted, and state transitions are conditional writes that exclude
 * already-terminal states. A retry whose original already landed therefore
 * throws before any row is written and surfaces as a 409 for most types — which
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
 *   - `step_started`  — its handler does an unconditional `attempt += 1` with a
 *                       `.where()` that only excludes terminal states, so a
 *                       retried start double-increments the attempt counter.
 *   - `step_retrying` — re-applies `pending` (idempotent state) but its handler
 *                       does NOT throw on a duplicate, so a retry appends a
 *                       second event-log row.
 *   - `hook_received` — has no server-side guard at all; a retry appends a
 *                       duplicate row and can re-deliver the payload.
 *
 * Only transient/ambiguous transport failures are retried; definitive responses
 * (409/410/425/429 and any other 4xx) surface immediately, exactly as before.
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

/** Every event type the world knows about (includes the server-only
 * `hook_conflict`, which the SDK never POSTs). */
type WorkflowEventType = z.infer<typeof EventTypeSchema>;

export interface EventRetryPolicy {
  /** Whether a failed POST of this event type may be retried in-process. */
  retryable: boolean;
  /** Why — kept in code so the validated classification is self-documenting. */
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
  // NOT safe to retry — see the module comment.
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
      'no server guard → a retry duplicates the row / re-delivers payload',
  },
  // Server-originated; the SDK never POSTs it.
  hook_conflict: {
    retryable: false,
    reason: 'server-originated; never POSTed by the SDK',
  },
} satisfies Record<WorkflowEventType, EventRetryPolicy>;

/** Up to this many retries after the initial attempt (3 attempts total). */
export const MAX_EVENT_POST_RETRIES = 2;
/** Base backoff; doubles per attempt. Kept tiny — the goal is riding out a
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
  // makeRequest) — a genuinely ambiguous failure worth retrying. We deliberately
  // do NOT include `AbortError`: that is how an external/caller-supplied
  // cancellation surfaces (makeRequest composes the caller's signal via
  // `AbortSignal.any`), and re-issuing a write the caller asked to cancel —
  // stalling the abort by the full backoff budget — would be wrong.
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
 * Whether a failed event POST should be retried. Retries transient/ambiguous
 * transport failures and transient 5xx; never retries a definitive response
 * (409/410/425/429 and other 4xx), which surfaces immediately as today.
 */
export function isRetryableEventPostError(err: unknown): boolean {
  // Definitive, server-considered outcomes — never retried in-process.
  // (425/429 are intentionally left to the runtime's retry-after handling.)
  if (
    EntityConflictError.is(err) ||
    RunExpiredError.is(err) ||
    TooEarlyError.is(err) ||
    ThrottleError.is(err)
  ) {
    return false;
  }

  if (WorkflowWorldError.is(err)) {
    // Body parsed past the response but the write may have landed — safe to
    // retry for eligible events (a landed original re-surfaces as 409).
    if (err.code === 'PARSE_ERROR') return true;
    if (typeof err.status === 'number') {
      // Transient server errors; 4xx are definitive and not retried.
      return err.status >= 500 && err.status <= 599;
    }
    // No status (e.g. a timeout wrapped by makeRequest) — fall through to the
    // transport-marker check on the error/cause chain.
  }

  return collectErrorMarkers(err).some((m) => TRANSIENT_CODES.has(m));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Gated like the rest of world-vercel's HTTP layer (`DEBUG=workflow:*`). Keeps
 * in-process retries visible during a latency/outage investigation — otherwise a
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

/**
 * Run an event POST, retrying transient transport failures in-process when the
 * event type is idempotent-on-retry. Non-retryable event types and definitive
 * responses run/throw on the first attempt, preserving existing behavior.
 */
export async function withEventPostRetry<T>(
  fn: () => Promise<T>,
  eventType: WorkflowEventType
): Promise<T> {
  const retryable = EVENT_RETRY_ELIGIBILITY[eventType]?.retryable ?? false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = retryable && isRetryableEventPostError(err);
      if (transient && attempt < MAX_EVENT_POST_RETRIES) {
        const backoff =
          EVENT_POST_RETRY_BASE_MS * 2 ** attempt +
          Math.floor(Math.random() * EVENT_POST_RETRY_JITTER_MS);
        logRetry('retrying event POST after transient failure', {
          eventType,
          attempt: attempt + 1,
          backoffMs: backoff,
          error: errorMarker(err),
        });
        await sleep(backoff);
        continue;
      }
      // Out of retries on a still-transient failure: surface it so the queue
      // redelivers (the worst-case fallthrough the in-process retry rode against).
      if (transient) {
        logRetry(
          'exhausted in-process retries; surfacing for queue redelivery',
          {
            eventType,
            attempts: attempt + 1,
            error: errorMarker(err),
          }
        );
      }
      throw err;
    }
  }
}
