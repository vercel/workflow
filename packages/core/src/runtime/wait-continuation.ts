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
 * dedupe each pass would enqueue another delayed continuation — each one
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
 *   clamped to `WAIT_CONTINUATION_MAX_DELAY_SECONDS` (23h — VQS messages
 *   have a 24h retention limit, and one hour of buffer matches
 *   world-vercel's own clamp for delayed re-enqueues), so the
 *   continuation intentionally fires early, re-observes the wait, and
 *   must enqueue the next hop. The key is suffixed with the hop index
 *   (`ceil(timeoutSeconds / maxDelay)`): stable for every re-observation
 *   within the same hop window (so passes dedupe), decremented at each
 *   hop delivery (so the chain always advances). Worlds without a delay
 *   limit (world-postgres, world-local) simply take the same ≤23h hops.
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
 * Host clock skew beyond the near-elapsed threshold could in principle
 * deliver such a continuation early enough to re-observe its wait and
 * lose the re-enqueue to the burnt key; the threshold is the skew
 * tolerance we accept for the benefit of exactly-one continuation per
 * wait.
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
 */
export function getWaitContinuationDispatch(
  timeoutSeconds: number,
  waitCorrelationId: string,
  now: number = Date.now()
): WaitContinuationDispatch {
  const maxDelaySeconds = getWaitContinuationMaxDelaySeconds();
  // The near-elapsed branch returns the full remaining time as the delay, so
  // its threshold can never exceed the max delay — otherwise a wait between the
  // max and the threshold would be dispatched with a delay above the max. Cap
  // the threshold at the max so every branch yields a delay within it. (With
  // defaults — threshold 2s, max 82_800s — this is a no-op; it only bites when
  // the max is tuned down below the threshold for testing.)
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
