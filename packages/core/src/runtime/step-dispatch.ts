import {
  getInlineOwnershipLeaseSeconds,
  getStepDispatchWatchdogSeconds,
} from './constants.js';

/**
 * Re-dispatch watchdog for a pending step whose dispatch is gone.
 *
 * A pending step is dispatched as a queue message keyed by the step's identity
 * (`stepDispatchIdempotencyKey`). A key claim outlives the message sent under
 * it: queues record the claim with a TTL of their own (a day is typical) and
 * do not release it when the message is delivered, acked, or exhausted, so a
 * later send under the same key produces no message at all. That is the
 * intended behaviour while the dispatch is doing its job — concurrent wake
 * replays must not multiply it — but it also means a step whose dispatch
 * stopped short of a terminal event can never be dispatched again by re-sending
 * the same key. The run then keeps replaying with one pending step that nothing
 * will execute: no divergence, no error, no terminal state.
 *
 * What this does NOT assume is that the queue lost a message. Delivery is
 * at-least-once, and an unacked delivery comes back on its own, so a redundant
 * send being absorbed is harmless for a dispatch that is still in flight. The
 * dispatches this matters for are the ones nothing will retry: a message that
 * was acked without the step reaching a terminal event (the step's execution
 * ended somewhere the queue considers success), and a send that collapsed into
 * an existing claim whose message is already finished. Both leave the step
 * pending with nothing outstanding, which is what the epoch below re-opens.
 *
 * The watchdog gives those dispatches an epoch, counted from the point the
 * dispatch is presumed lost (see `dispatchLostAtMs`), which the dispatch key is
 * suffixed with. Every replay derives the epoch from durable event timestamps,
 * so concurrent replays agree on the key and fan-out stays capped at one
 * message per epoch, while a step still pending an interval later gets a key
 * the queue has never seen and is dispatched again.
 *
 * Out of scope: a step in `step_retrying`. Its retry is already queued under
 * the unsuffixed key with a backoff that can legitimately exceed any interval
 * here, and re-dispatching it would duplicate work that is scheduled and
 * healthy.
 *
 * Re-dispatch is at-least-once: if the original message was merely slow
 * rather than lost, both deliveries execute the step body and the loser's
 * terminal write is rejected as a conflict. Both deadlines are set well above
 * normal latency so that trade only happens for dispatches that really are
 * gone.
 */

/**
 * The replay-derived facts about one pending step the watchdog needs.
 * `StepInvocationQueueItem` (the node engine's queue item) satisfies it
 * structurally; the quickjs engine builds one from its own per-step
 * ownership map.
 */
export interface StepDispatchState {
  correlationId: string;
  /**
   * `createdAt` (ms) of the step's durable `step_created`: stamped by the
   * suspension that wrote it, and re-derived from the log by every later
   * replay. Undefined means no durable creation is known to this
   * invocation (a lazily-created inline step, or a world whose events carry
   * no usable timestamp), which leaves the step out of watchdog scope.
   */
  createdEventAt?: number;
  /** `createdAt` (ms) of the latest observed `step_started`, if any. */
  lastStartedAt?: number;
  /** Whether a `step_retrying` was observed, which implies a prior start. */
  sawRetrying?: boolean;
}

/**
 * Whether a pending step is waiting for its first `step_started`: a durable
 * creation timestamp is known, no start has been observed, and no
 * `step_retrying` (which implies a prior start).
 */
export function isStepAwaitingFirstStart(step: StepDispatchState): boolean {
  return (
    step.createdEventAt !== undefined &&
    step.lastStartedAt === undefined &&
    step.sawRetrying !== true
  );
}

/**
 * The instant a pending step's current dispatch is presumed lost, as an
 * absolute epoch-ms timestamp, or undefined when the step is out of scope.
 *
 * Unstarted steps are presumed lost one watchdog interval after their durable
 * `step_created`: nothing else bounds how long a dispatch may sit before it
 * produces a start.
 *
 * Started steps are presumed lost at the end of their ownership lease. That is
 * the same deadline `stepLeaseRemainingSeconds` uses to schedule the inline
 * backstop wake, so the wake and the key it re-dispatches under move together.
 * Anchoring on the lease rather than on a watchdog interval is what keeps
 * healthy long-running step bodies from being duplicated: the lease is the
 * runtime's existing statement of how long an executing step may be presumed
 * alive.
 */
export function dispatchLostAtMs(step: StepDispatchState): number | undefined {
  if (step.sawRetrying === true) return undefined;
  if (step.lastStartedAt !== undefined) {
    return step.lastStartedAt + getInlineOwnershipLeaseSeconds() * 1000;
  }
  if (step.createdEventAt === undefined) return undefined;
  return step.createdEventAt + getStepDispatchWatchdogSeconds() * 1000;
}

/**
 * How many re-dispatches the watchdog has reached for this step. 0 means the
 * current dispatch is not yet presumed lost, or the step is out of scope (a
 * retry in flight, or a world whose events carry no usable timestamp) — in
 * both cases dispatch keeps the unsuffixed identity key, which every other
 * producer of a step message uses. Past that the epoch advances once per
 * watchdog interval, so a re-dispatch that is itself lost is followed by
 * another.
 */
export function stepDispatchEpoch(
  step: StepDispatchState,
  nowMs: number
): number {
  const lostAtMs = dispatchLostAtMs(step);
  if (lostAtMs === undefined) return 0;
  const elapsedMs = nowMs - lostAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / (getStepDispatchWatchdogSeconds() * 1000)) + 1;
}

/**
 * When the step's next watchdog boundary falls, as an absolute epoch-ms
 * timestamp, or undefined when the step is out of scope. Derived from durable
 * event timestamps so every replay computes the same boundary, which is what
 * lets the wake armed for it dedupe across replays.
 */
export function nextStepDispatchBoundaryMs(
  step: StepDispatchState,
  nowMs: number
): number | undefined {
  const lostAtMs = dispatchLostAtMs(step);
  if (lostAtMs === undefined) return undefined;
  const epoch = stepDispatchEpoch(step, nowMs);
  // Epoch 0 has not reached the lost-at instant yet, so that instant is itself
  // the next boundary. Past it, each epoch lasts one watchdog interval.
  if (epoch === 0) return lostAtMs;
  return lostAtMs + epoch * getStepDispatchWatchdogSeconds() * 1000;
}

/**
 * The wake a suspension arms so a pending step's next watchdog boundary is
 * observed even when nothing else would wake the run. Without it the watchdog
 * only helps runs that happen to keep receiving hooks or wait timers; a run
 * whose sole outstanding work is the lost dispatch would never replay again.
 *
 * At most one wake per suspension: the earliest boundary among the pending
 * steps, since a replay at that point re-evaluates all of them. Ties break on
 * correlation ID so concurrent replays pick the same step and therefore the
 * same key.
 */
export function getStepDispatchWake(
  steps: StepDispatchState[],
  nowMs: number
): { delaySeconds: number; idempotencyKey: string } | undefined {
  let earliest: { boundaryMs: number; correlationId: string } | undefined;
  for (const step of steps) {
    const boundaryMs = nextStepDispatchBoundaryMs(step, nowMs);
    if (boundaryMs === undefined) continue;
    if (
      !earliest ||
      boundaryMs < earliest.boundaryMs ||
      (boundaryMs === earliest.boundaryMs &&
        step.correlationId < earliest.correlationId)
    ) {
      earliest = { boundaryMs, correlationId: step.correlationId };
    }
  }
  if (!earliest) return undefined;
  // A second of slack past the boundary, because a wake that lands even
  // marginally early computes the same epoch, re-arms the same key, and is
  // deduped away — leaving the run with no timer at all. The delay must
  // therefore never be clamped BELOW the distance to the boundary it is keyed
  // on: an early wake is worse than no wake, since it also burns the key.
  //
  // The ceiling exists only to bound clock skew (a `step_created` or
  // `step_started` stamped in the future would otherwise ask for a delay above
  // the queue's per-message maximum). A boundary is at most one watchdog
  // interval past an unstarted step's creation or one ownership lease past a
  // started step's latest start, so the larger of the two covers every
  // legitimate boundary and nothing else. Floored at 1s because a boundary
  // already past still has to be a valid delay.
  const maxDelaySeconds =
    Math.max(
      getStepDispatchWatchdogSeconds(),
      getInlineOwnershipLeaseSeconds()
    ) + 1;
  const delaySeconds = Math.min(
    maxDelaySeconds,
    Math.max(1, Math.ceil((earliest.boundaryMs - nowMs) / 1000) + 1)
  );
  return {
    delaySeconds,
    idempotencyKey: `${earliest.correlationId}:dispatch-wake:${earliest.boundaryMs}`,
  };
}
