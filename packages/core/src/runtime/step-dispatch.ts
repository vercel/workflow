import {
  getInlineOwnershipLeaseSeconds,
  getStepDispatchWatchdogSeconds,
  MAX_STEP_DISPATCH_WATCHDOG_SECONDS,
} from './constants.js';

/**
 * Re-dispatch watchdog for a pending step whose dispatch is gone.
 *
 * A pending step is dispatched as a queue message keyed by its correlation
 * ID. Queues dedupe an idempotency key for the lifetime of the original
 * message, so that key is effectively permanent: once a message has been
 * accepted under it, every later replay's re-send is silently absorbed. That
 * is the intended behaviour while the message is doing its job — concurrent
 * wake replays must not multiply the dispatch — but it also means a step whose
 * message stops making progress can never be dispatched again. The run then
 * keeps replaying forever with one pending step that nothing will ever
 * execute: no divergence, no error, no terminal state.
 *
 * Two ways a dispatch stops making progress, both observed on the race repro:
 *
 * 1. The message is accepted and never delivered, so no `step_started` is
 *    ever written.
 * 2. The message is delivered, the step writes `step_started`, and the
 *    invocation executing the body disappears before writing a terminal
 *    event. Inline-owned steps have a backstop wake at their ownership lease
 *    for exactly this, but the wake only brings a replay back: the re-dispatch
 *    it then attempts carried the bare correlation ID, which the queue had
 *    already claimed, so the recovery was absorbed and the run went silent for
 *    good.
 *
 * The watchdog gives those dispatches an epoch, counted from the point the
 * dispatch is presumed lost (see `dispatchLostAtMs`). Every replay derives the
 * epoch from durable event timestamps, so concurrent replays agree on the key
 * and fan-out stays capped at one message per epoch, while a step still
 * pending an interval later gets a key the queue has never seen and is
 * dispatched again.
 *
 * Out of scope: a step in `step_retrying`. Its retry is already queued under
 * the bare key with a backoff that can legitimately exceed any interval here,
 * and re-dispatching it would duplicate work that is scheduled and healthy.
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
 * both cases dispatch keeps the bare correlation-ID key and today's behaviour
 * exactly. Past that the epoch advances once per watchdog interval, so a
 * re-dispatch that is itself lost is followed by another.
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
 * Idempotency key for a pending step's dispatch message. Epoch 0 is the bare
 * correlation ID, which is also the key the owner's retry handoff enqueues
 * under — the two must agree so a re-dispatch never races a queued retry.
 * Later epochs suffix the key so the queue sees a message it has not
 * deduped.
 */
export function stepDispatchIdempotencyKey(
  step: StepDispatchState,
  nowMs: number
): string {
  const epoch = stepDispatchEpoch(step, nowMs);
  return epoch === 0
    ? step.correlationId
    : `${step.correlationId}:dispatch:${epoch}`;
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
  // deduped away — leaving the run with no timer at all. Clamped to the
  // watchdog interval so a creation timestamp in the future (clock skew)
  // cannot ask for a delay above the queue's per-message maximum, and floored
  // at 1s because a boundary already past still has to be a valid delay.
  const maxDelaySeconds = Math.min(
    getStepDispatchWatchdogSeconds() + 1,
    MAX_STEP_DISPATCH_WATCHDOG_SECONDS
  );
  const delaySeconds = Math.min(
    maxDelaySeconds,
    Math.max(1, Math.ceil((earliest.boundaryMs - nowMs) / 1000) + 1)
  );
  return {
    delaySeconds,
    idempotencyKey: `${earliest.correlationId}:dispatch-wake:${earliest.boundaryMs}`,
  };
}
