import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isVmIdle,
  notifyVmIdleObservers,
  scheduleWhenIdle,
  trackVmDelivery,
  type WorkflowOrchestratorContext,
} from './private.js';

/**
 * Builds a minimal `WorkflowOrchestratorContext` containing only the fields
 * `scheduleWhenIdle` and the counter helpers touch. Other fields are
 * intentionally absent; the cast keeps the harness narrow without dragging in
 * EventsConsumer/VM setup.
 */
function makeCtx(): WorkflowOrchestratorContext {
  return {
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
    pendingVmWork: 0,
    vmIdleObservers: new Set<() => void>(),
  } as unknown as WorkflowOrchestratorContext;
}

/**
 * `scheduleWhenIdle` chains through `ctx.promiseQueue` (await) and one
 * `setTimeout(0)` macrotask before checking the counters for the first time.
 * Any test that expects a fire to happen on the fast path needs to advance
 * past those hops. A small budget covers them with margin to spare.
 */
const FAST_PATH_DRAIN_MS = 10;

describe('isVmIdle', () => {
  it('returns true when both counters are 0', () => {
    const ctx = makeCtx();
    expect(isVmIdle(ctx)).toBe(true);
  });

  it('returns false when pendingDeliveries > 0', () => {
    const ctx = makeCtx();
    ctx.pendingDeliveries = 1;
    expect(isVmIdle(ctx)).toBe(false);
  });

  it('returns false when pendingVmWork > 0', () => {
    const ctx = makeCtx();
    ctx.pendingVmWork = 1;
    expect(isVmIdle(ctx)).toBe(false);
  });
});

describe('notifyVmIdleObservers', () => {
  it('fires registered observers when the host is idle', () => {
    const ctx = makeCtx();
    const observer = vi.fn();
    ctx.vmIdleObservers.add(observer);
    notifyVmIdleObservers(ctx);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the host is still busy', () => {
    const ctx = makeCtx();
    ctx.pendingDeliveries = 1;
    const observer = vi.fn();
    ctx.vmIdleObservers.add(observer);
    notifyVmIdleObservers(ctx);
    expect(observer).not.toHaveBeenCalled();
  });

  it('clears observers before firing (single-shot semantics)', () => {
    const ctx = makeCtx();
    const observer = vi.fn();
    ctx.vmIdleObservers.add(observer);
    notifyVmIdleObservers(ctx);
    notifyVmIdleObservers(ctx);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('does not let one throwing observer block others', () => {
    const ctx = makeCtx();
    const obs1 = vi.fn(() => {
      throw new Error('boom');
    });
    const obs2 = vi.fn();
    ctx.vmIdleObservers.add(obs1);
    ctx.vmIdleObservers.add(obs2);
    notifyVmIdleObservers(ctx);
    expect(obs1).toHaveBeenCalledTimes(1);
    expect(obs2).toHaveBeenCalledTimes(1);
  });
});

describe('trackVmDelivery', () => {
  it('increments both counters synchronously at entry', () => {
    const ctx = makeCtx();
    trackVmDelivery(ctx, async () => 'ok');
    expect(ctx.pendingDeliveries).toBe(1);
    expect(ctx.pendingVmWork).toBe(1);
  });

  it('decrements pendingDeliveries synchronously when body resolves; pendingVmWork drops after setImmediate', async () => {
    const ctx = makeCtx();
    let observedDeliveries = -1;
    let observedVmWork = -1;
    const promise = trackVmDelivery(ctx, async () => {
      observedDeliveries = ctx.pendingDeliveries;
      observedVmWork = ctx.pendingVmWork;
      return 'ok';
    });
    const result = await promise;
    expect(result).toBe('ok');
    expect(observedDeliveries).toBe(1);
    expect(observedVmWork).toBe(1);
    expect(ctx.pendingDeliveries).toBe(0);
    await new Promise<void>((r) => setImmediate(r));
    expect(ctx.pendingVmWork).toBe(0);
  });

  it('decrements counters even when body rejects', async () => {
    const ctx = makeCtx();
    await expect(
      trackVmDelivery(ctx, async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    expect(ctx.pendingDeliveries).toBe(0);
    await new Promise<void>((r) => setImmediate(r));
    expect(ctx.pendingVmWork).toBe(0);
  });

  it('runs bodies in promiseQueue order even when later bodies hydrate faster', async () => {
    const ctx = makeCtx();
    const observed: string[] = [];
    const slow = trackVmDelivery(ctx, async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      observed.push('slow');
    });
    const fast = trackVmDelivery(ctx, async () => {
      observed.push('fast');
    });
    // pendingDeliveries reflects both queued bodies before either has run
    expect(ctx.pendingDeliveries).toBe(2);
    await Promise.all([slow, fast]);
    expect(observed).toEqual(['slow', 'fast']);
  });

  it('does not poison subsequent deliveries when an earlier body rejects', async () => {
    const ctx = makeCtx();
    const observed: string[] = [];
    const first = trackVmDelivery(ctx, async () => {
      throw new Error('first');
    });
    const second = trackVmDelivery(ctx, async () => {
      observed.push('second');
    });
    await expect(first).rejects.toThrow('first');
    await second;
    expect(observed).toEqual(['second']);
  });
});

describe('scheduleWhenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on the fast path when both counters are already 0', async () => {
    const ctx = makeCtx();
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not fire while pendingDeliveries > 0', async () => {
    const ctx = makeCtx();
    ctx.pendingDeliveries = 1;
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not fire while pendingVmWork > 0', async () => {
    const ctx = makeCtx();
    ctx.pendingVmWork = 1;
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires once both counters drain via observer notification', async () => {
    const ctx = makeCtx();
    ctx.pendingDeliveries = 1;
    ctx.pendingVmWork = 1;
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();
    // Drain counters and notify the observer
    ctx.pendingDeliveries = 0;
    ctx.pendingVmWork = 0;
    notifyVmIdleObservers(ctx);
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-waits when a new delivery starts between notification and fire', async () => {
    const ctx = makeCtx();
    ctx.pendingVmWork = 1;
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();

    // Counters momentarily reach 0; notify observers. But before the
    // re-check macrotask runs, simulate a fresh delivery landing.
    ctx.pendingVmWork = 0;
    notifyVmIdleObservers(ctx);
    ctx.pendingDeliveries = 1;

    // The post-notification drain re-evaluates and sees the new delivery,
    // so fn must NOT fire.
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).not.toHaveBeenCalled();

    // Now drain the new delivery and notify again — fn fires.
    ctx.pendingDeliveries = 0;
    notifyVmIdleObservers(ctx);
    await vi.advanceTimersByTimeAsync(FAST_PATH_DRAIN_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires after the watchdog when counters are stuck', async () => {
    const ctx = makeCtx();
    // pendingVmWork stays >0 forever (simulating a lost decrement)
    ctx.pendingVmWork = 1;
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);

    // Well past the fast-path drain but well within the 5-second watchdog
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).not.toHaveBeenCalled();

    // Cross the watchdog ceiling — fn fires defensively
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires only once even if both the observer and the watchdog race', async () => {
    const ctx = makeCtx();
    ctx.pendingVmWork = 1;
    const fn = vi.fn();
    scheduleWhenIdle(ctx, fn);

    // Notify just before the watchdog fires
    await vi.advanceTimersByTimeAsync(4900);
    ctx.pendingVmWork = 0;
    notifyVmIdleObservers(ctx);
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
