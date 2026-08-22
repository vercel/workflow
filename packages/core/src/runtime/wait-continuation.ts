/**
 * Wait-continuation dispatch: delay + idempotency-key selection.
 *
 * When V2 suspension processing observes a pending wait, it enqueues a
 * delayed "continuation" message that fires once the wait elapses and
 * drives the next replay (which completes the wait via the "complete
 * elapsed waits" pass). This module decides the message's `delaySeconds`
 * and `idempotencyKey`.
 *
 * The continuation is keyed on the wait's correlationId: while a wait is
 * pending, every replay pass over the run re-observes it (e.g., once per
 * step completion in `Promise.all([steps..., sleep()])`), and without
 * dedupe each pass would enqueue another delayed continuation: each one
 * a spurious full replay when the wait elapses, and each a fresh message
 * that resets the delivery-attempt runaway guard. A key is attached in
 * all cases: some worlds (e.g. world-postgres) serialize key-less
 * workflow messages per run, which would park the continuation behind
 * the handler's own inline step execution and defeat the race semantics
 * the continuation exists to provide.
 *
 * The bare correlationId cannot be the key in every case, though: world
 * dedupe windows outlive the first delivery (VQS keeps idempotency
 * records until message-retention TTL; world-postgres keeps a
 * completed-keys cache), so once a key has been used, a later enqueue
 * under the same key is silently dropped. Any situation where a
 * continuation is delivered while its wait is still pending therefore
 * needs a fresh key for the re-enqueue, or the wait's timer is lost and
 * the run stalls until unrelated traffic happens to wake it. Two such
 * situations exist, each with its own key variation:
 *
 * - Waits longer than the maximum queue delay are chained: the delay is
 *   clamped to `WAIT_CONTINUATION_MAX_DELAY_SECONDS` (23h: VQS messages
 *   have a 24h retention limit, and one hour of buffer matches
 *   world-vercel's own clamp for delayed re-enqueues), so the
 *   continuation intentionally fires early, re-observes the wait, and
 *   must enqueue the next hop. The key is suffixed with the hop index
 *   (`ceil(timeoutSeconds / maxDelay)`): stable for every re-observation
 *   within the same hop window (so passes dedupe), decremented at each
 *   hop delivery (so the chain always advances). Worlds without a delay
 *   limit (world-postgres, world-local) take the same ≤23h hops.
 *
 * - Near-elapsed waits (≤2s remaining) get a second-bucketed suffix. A
 *   continuation delivered marginally early (clock skew between the
 *   enqueuing and handling hosts; the ceil() on the delay can leave a ~0
 *   margin) re-observes the wait as pending with ~1s remaining and must
 *   be able to enqueue a fresh short-delay retry. The bucket suffix
 *   keeps that retry enqueueable (its ≥1s delay guarantees a later
 *   bucket) while still collapsing same-instant duplicates.
 *
 * Mid-range waits (more than the near-elapsed threshold, at most one
 * hop) use the bare correlationId: every re-observation targets the same
 * deadline, so deduping to the first message is semantically lossless.
 *
 * That last case used to be the one hole in the scheme, and it was not
 * theoretical. Any delivery early enough to re-observe its own wait as
 * pending burns the bare key on the way in: the re-enqueue is dropped by
 * the dedupe window, nothing else is scheduled to wake the run, and no
 * backstop exists for a wait the way inline step ownership provides one
 * for a step. The run sleeps forever. Waits over the threshold have zero
 * tolerance for it, which is why an infrastructure change in delivery
 * timing was able to strand runs across every published SDK version at
 * once, all of them keyed this way.
 *
 * So the key is no longer derived from the wait alone. A continuation
 * carries the wait it was armed for and its attempt number
 * ({@link WorkflowInvokePayload.waitContinuation}), and an invocation
 * that recognizes itself as the continuation for a wait that is still
 * pending arms the next one at `attempt + 1`. Attempts advance ONLY when
 * an early delivery actually happens, so the normal path is untouched:
 * attempt 0 keys exactly as before, and every re-observation within one
 * attempt still collapses to a single message.
 */

import { envNumber } from '@workflow/world';

/**
 * Maximum `delaySeconds` for a single wait-continuation message. Waits
 * longer than this are chained across multiple hops. 23 hours leaves a 1h
 * buffer under Vercel Queues' default 24h message TTL and mirrors
 * world-vercel's `MAX_DELAY_SECONDS`.
 */
export const WAIT_CONTINUATION_MAX_DELAY_SECONDS = 82_800;

/**
 * Waits with at most this many seconds remaining use a second-bucketed
 * idempotency key so an early-delivered continuation can re-enqueue its
 * short-delay retry. This is also the host clock-skew tolerance for
 * mid-range waits keyed on the bare correlationId.
 */
export const NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS = 2;

/** Effective max continuation delay. Override: `WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS`. */
const getWaitContinuationMaxDelaySeconds = (): number =>
  envNumber(
    'WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS',
    WAIT_CONTINUATION_MAX_DELAY_SECONDS,
    { integer: true, min: 1 }
  );

/** Effective near-elapsed threshold. Override: `WORKFLOW_NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS`. */
const getNearElapsedWaitThresholdSeconds = (): number =>
  envNumber(
    'WORKFLOW_NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS',
    NEAR_ELAPSED_WAIT_THRESHOLD_SECONDS
  );

export interface WaitContinuationDispatch {
  delaySeconds: number;
  idempotencyKey: string;
}

/**
 * Computes the queue delay and idempotency key for a wait-continuation
 * message. `timeoutSeconds` is the time until the wait's `resumeAt`
 * (floored at 1s by the suspension handler); `waitCorrelationId`
 * identifies the wait so repeated suspension passes dedupe.
 *
 * `attempt` is the number of continuations already spent on this wait, taken
 * from the incoming message when this invocation IS one of them (see
 * {@link WorkflowInvokePayload.waitContinuation}). It only ever moves when a
 * continuation arrived before its wait elapsed, which is exactly when the
 * previous key is spent and re-using it would drop the message. Attempt 0
 * keys identically to the scheme before attempts existed, so the ordinary
 * path — arm once, deliver once, complete — is byte-for-byte unchanged.
 */
export function getWaitContinuationDispatch(
  timeoutSeconds: number,
  waitCorrelationId: string,
  now: number = Date.now(),
  attempt = 0
): WaitContinuationDispatch {
  const dispatch = waitContinuationDispatchForAttemptZero(
    timeoutSeconds,
    waitCorrelationId,
    now
  );
  if (attempt <= 0) return dispatch;
  return {
    delaySeconds: dispatch.delaySeconds,
    idempotencyKey: `${dispatch.idempotencyKey}:a${attempt}`,
  };
}

function waitContinuationDispatchForAttemptZero(
  timeoutSeconds: number,
  waitCorrelationId: string,
  now: number
): WaitContinuationDispatch {
  const maxDelaySeconds = getWaitContinuationMaxDelaySeconds();
  // The near-elapsed branch returns the full remaining time as the delay, so
  // its threshold can never exceed the max delay. Otherwise a wait between the
  // max and the threshold would be dispatched with a delay above the max. Cap
  // the threshold at the max so every branch yields a delay within it. (With
  // defaults, threshold 2s and max 82_800s, this is a no-op; it only bites
  // when the max is tuned down below the threshold for testing.)
  const nearElapsedThreshold = Math.min(
    getNearElapsedWaitThresholdSeconds(),
    maxDelaySeconds
  );
  if (timeoutSeconds <= nearElapsedThreshold) {
    return {
      delaySeconds: timeoutSeconds,
      idempotencyKey: `${waitCorrelationId}:${Math.floor(now / 1000)}`,
    };
  }

  const hop = Math.ceil(timeoutSeconds / maxDelaySeconds);
  return {
    delaySeconds: Math.min(timeoutSeconds, maxDelaySeconds),
    idempotencyKey:
      hop === 1 ? waitCorrelationId : `${waitCorrelationId}:hop-${hop}`,
  };
}
