import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';

// On stable, the `DEFERRED_CHECK_DELAY_MS` export from `events-consumer.ts`
// does not exist yet — it was introduced on 5.x. We mirror the same 100ms
// value here so the assertions can drive the scheduleWhenIdle state machine
// against the inlined REPLAY_PROPAGATION_DELAY_MS in `private.ts`.
const DEFERRED_CHECK_DELAY_MS = 100;

/**
 * Builds a minimal WorkflowOrchestratorContext containing only the fields
 * scheduleWhenIdle reads. Other fields are intentionally absent; the cast keeps
 * the harness narrow without dragging in EventsConsumer/VM setup.
 */
function makeCtx(): WorkflowOrchestratorContext {
  return {
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
  } as unknown as WorkflowOrchestratorContext;
}

/**
 * Replaces `ctx.pendingDeliveries` with a getter that returns each value in
 * `sequence` on successive reads, then sticks at the final value. This lets us
 * simulate "delivery saw 1, then drained to 0" without driving multiple
 * polling iterations under fake timers — every 0ms re-poll while
 * `pendingDeliveries > 0` schedules a fresh 0ms timer, which would trip
 * vitest's loopLimit safeguard if we tried to advance through it.
 */
function stubPendingDeliveries(
  ctx: WorkflowOrchestratorContext,
  sequence: number[]
): void {
  let i = 0;
  Object.defineProperty(ctx, 'pendingDeliveries', {
    configurable: true,
    get: () => {
      const value =
        i < sequence.length ? sequence[i] : sequence[sequence.length - 1];
      i++;
      return value;
    },
  });
}

// Pick a quiet step that drives the 0ms-timer/microtask chain to completion
// without crossing the propagation delay. ~half of DEFERRED_CHECK_DELAY_MS is
// well past any internal 0ms hops but well below the deferred fire time.
const DRAIN_MS = Math.floor(DEFERRED_CHECK_DELAY_MS / 2);

describe('scheduleWhenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately on the fast path when no deliveries are observed', async () => {
    const ctx = makeCtx();
    const fn = vi.fn();
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    scheduleWhenIdle(ctx, fn);
    expect(fn).not.toHaveBeenCalled();

    // Drive the entire 0ms chain. fn must fire well before
    // DEFERRED_CHECK_DELAY_MS, and the propagation timer must never have been
    // armed (since no deliveries were ever observed).
    await vi.advanceTimersByTimeAsync(DRAIN_MS);

    expect(fn).toHaveBeenCalledTimes(1);
    const deferredCalls = timerSpy.mock.calls.filter(
      ([, delay]) => delay === DEFERRED_CHECK_DELAY_MS
    );
    expect(deferredCalls).toHaveLength(0);
  });

  it('defers firing by DEFERRED_CHECK_DELAY_MS once an idle cycle observed deliveries', async () => {
    const ctx = makeCtx();
    // First poll sees 1 (arms sawPendingDeliveries); subsequent reads see 0
    // so the polling loop terminates and fireWhenReady is reached.
    stubPendingDeliveries(ctx, [1, 0]);
    const fn = vi.fn();
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    scheduleWhenIdle(ctx, fn);

    // Drive the chain past every 0ms hop but stay inside the propagation
    // window. fn must still be pending while the deferred timer ticks.
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();
    const deferredCalls = timerSpy.mock.calls.filter(
      ([, delay]) => delay === DEFERRED_CHECK_DELAY_MS
    );
    expect(deferredCalls.length).toBeGreaterThan(0);

    // Cross the propagation delay; fn fires.
    await vi.advanceTimersByTimeAsync(DEFERRED_CHECK_DELAY_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-loops when pendingDeliveries reappears during the deferred wait', async () => {
    const ctx = makeCtx();
    // First poll sees 1 (arms saw), drains to 0 (enters deferred wait), then
    // a new delivery (1) reappears when the deferred timer fires, and
    // finally drains to 0 again.
    stubPendingDeliveries(ctx, [1, 0, 0, 1, 0]);
    const fn = vi.fn();

    scheduleWhenIdle(ctx, fn);

    // First deferred window: timer fires, sees a fresh delivery, re-enters
    // the polling loop instead of suspending.
    await vi.advanceTimersByTimeAsync(DEFERRED_CHECK_DELAY_MS + DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();

    // Second deferred window: deliveries are drained, fn fires.
    await vi.advanceTimersByTimeAsync(DEFERRED_CHECK_DELAY_MS * 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while pendingDeliveries persists across multiple check rounds', async () => {
    const ctx = makeCtx();
    // Deliveries stay non-zero for several `check` iterations before draining.
    // Each non-zero read takes the "still delivering" branch (queue drain ->
    // setTimeout(0) -> check again), exercising the multi-iteration poll path
    // that the other tests collapse into a single round.
    stubPendingDeliveries(ctx, [2, 1, 1, 0, 0]);
    const fn = vi.fn();

    scheduleWhenIdle(ctx, fn);

    // Drive the chain past several 0ms hops but stay well inside the
    // propagation window. fn must still be pending while the poll loops.
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();

    // After the poll finally observes 0 and the propagation delay elapses,
    // fn fires exactly once.
    await vi.advanceTimersByTimeAsync(DEFERRED_CHECK_DELAY_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
