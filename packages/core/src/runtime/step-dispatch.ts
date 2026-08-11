import {
  getStepDispatchWatchdogSeconds,
  MAX_STEP_DISPATCH_WATCHDOG_SECONDS,
} from './constants.js';

/**
 * Re-dispatch watchdog for a step that was created but never started.
 *
 * A pending step is dispatched as a queue message keyed by its correlation
 * ID. Queues dedupe an idempotency key for the lifetime of the original
 * message, so that key is effectively permanent: once a message has been
 * accepted under it, every later replay's re-send is silently absorbed. That
 * is the intended behaviour while the message is doing its job — concurrent
 * wake replays must not multiply the dispatch — but it also means a step
 * whose message never produces a `step_started` can never be dispatched
 * again. The run then keeps replaying forever with one pending step that
 * nothing will ever execute: no divergence, no error, no terminal state.
 *
 * The watchdog gives those dispatches an epoch. Every replay derives the
 * epoch from the step's durable `step_created` timestamp, so concurrent
 * replays agree on the key and fan-out stays capped at one message per epoch,
 * while a step still unstarted a full watchdog interval later gets a key the
 * queue has never seen and is dispatched again.
 *
 * Scope: only steps awaiting their FIRST `step_started`. A step that has
 * started is either running (its body has no completion deadline the client
 * can see, so re-dispatching on a timer would duplicate healthy long-running
 * work) or inline-owned (covered by the ownership lease and its backstop in
 * step-ownership.ts).
 *
 * Re-dispatch is at-least-once: if the original message was merely slow
 * rather than lost, both deliveries execute the step body and the loser's
 * terminal write is rejected as a conflict. The default interval is set well
 * above normal dispatch-to-start latency so that trade only happens for
 * dispatches that really are gone.
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
 * `step_retrying` (which implies a prior start). Steps outside this state keep
 * the bare correlation-ID key.
 */
export function isStepAwaitingFirstStart(step: StepDispatchState): boolean {
  return (
    step.createdEventAt !== undefined &&
    step.lastStartedAt === undefined &&
    step.sawRetrying !== true
  );
}

/**
 * How many full watchdog intervals have elapsed since the step's
 * `step_created`. 0 means the current dispatch is still within its first
 * interval, or the step is out of scope / has no usable creation timestamp
 * (worlds whose events lack them) — in both cases dispatch keeps today's
 * behaviour exactly.
 */
export function stepDispatchEpoch(
  step: StepDispatchState,
  nowMs: number
): number {
  const createdEventAt = step.createdEventAt;
  if (createdEventAt === undefined || !isStepAwaitingFirstStart(step)) return 0;
  const elapsedMs = nowMs - createdEventAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / (getStepDispatchWatchdogSeconds() * 1000));
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
 * timestamp, or undefined when the step is out of scope. Derived from the
 * durable creation timestamp so every replay computes the same boundary,
 * which is what lets the wake armed for it dedupe across replays.
 */
export function nextStepDispatchBoundaryMs(
  step: StepDispatchState,
  nowMs: number
): number | undefined {
  const createdEventAt = step.createdEventAt;
  if (createdEventAt === undefined || !isStepAwaitingFirstStart(step)) {
    return undefined;
  }
  const watchdogMs = getStepDispatchWatchdogSeconds() * 1000;
  return createdEventAt + (stepDispatchEpoch(step, nowMs) + 1) * watchdogMs;
}

/**
 * The wake a suspension arms so an unstarted step's next watchdog boundary is
 * observed even when nothing else would wake the run. Without it the watchdog
 * only helps runs that happen to keep receiving hooks or wait timers; a run
 * whose sole outstanding work is the lost dispatch would never replay again.
 *
 * At most one wake per suspension: the earliest boundary among the pending
 * unstarted steps, since a replay at that point re-evaluates all of them. Ties
 * break on correlation ID so concurrent replays pick the same step and
 * therefore the same key.
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
