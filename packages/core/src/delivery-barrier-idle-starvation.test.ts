/**
 * The inverse failure of `delivery-barrier-idle-collapse.test.ts`.
 *
 * A barrier registered by `registerDeliveryBarrier` (`private.ts:266-299`) has
 * exactly two retirement paths: `markDelivered()`, called when the delivery
 * reaches workflow code, and the idle safety net armed at registration —
 * `scheduleWhenIdle(ctx, finish)` at `private.ts:296`. For a delivery the
 * workflow never observes (its branch was not taken, or the run is suspending),
 * the safety net is the ONLY path.
 *
 * `scheduleWhenIdle` (`private.ts:321-336`) is an unbounded poll:
 *
 *     const check = () => {
 *       if (ctx.pendingDeliveries > 0) {
 *         ctx.promiseQueue.then(() => { setTimeout(check, 0); });
 *       } else { fn(); }
 *     };
 *     setTimeout(check, 0);
 *
 * There is no deadline, no iteration cap and no escape: while any unrelated
 * delivery is in the host-side hydration window, every armed net re-schedules
 * itself. `pendingDeliveries` is a single global counter, so the traffic keeping
 * it non-zero need not have anything to do with the barrier waiting on it — a
 * stream of payloads arriving for a hook nobody reads is enough, and each
 * arrival registers another barrier that arms another poll.
 *
 * A later opposite-kind delivery gated on the unretired barrier via
 * `awaitEarlierDeliveries` then blocks for as long as the traffic lasts. This is
 * the shape observed live under the step-storm repro: one run made no progress
 * for 3m19s across 228 deliveries to a never-read poke hook, and later runs in
 * the same shape died with REPLAY_TIMEOUT.
 *
 * Both this and the premature-collapse failure follow from the same decision:
 * a barrier's retirement is tied to a global "the system is idle" predicate
 * rather than to that barrier's own delivery. `pendingDeliveries === 0` is not
 * a proxy for "this delivery was abandoned" in either direction, and no
 * threshold makes it one — when idle arrives early the ordering guarantee
 * collapses, and when it never arrives the run hangs.
 *
 * The first and third tests assert the CORRECT behavior — an abandoned barrier
 * retires within a bounded time, whatever unrelated deliveries are in flight —
 * so they fail on `main`. The second is a control: it passes, and shows the
 * traffic is the whole reason, since retirement happens immediately once the
 * counter reaches zero.
 */
import { withResolvers } from '@workflow/utils';
import { describe, expect, it } from 'vitest';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';

function makeCtx(): WorkflowOrchestratorContext {
  const promiseQueueHolder = { current: Promise.resolve() };
  return {
    pendingDeliveryBarriers: new Map(),
    pendingDeliveries: 0,
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
  } as unknown as WorkflowOrchestratorContext;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const macrotasks = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await macrotask();
  }
};

/**
 * Models a continuous stream of deliveries for a hook the workflow never reads:
 * the next payload's hydration begins before the previous one's slot ends, so
 * `pendingDeliveries` never touches zero. Each arrival also extends
 * `promiseQueue`, which is what keeps an armed `scheduleWhenIdle` poll spinning
 * rather than stalling.
 *
 * This is the poke cadence of the step-storm repro, not a pathological case
 * constructed for the test: an out-of-band resume every ~750ms against a run
 * whose hydration takes longer than that produces exactly this overlap.
 */
function startPokeStorm(ctx: WorkflowOrchestratorContext): () => void {
  let stopped = false;
  // The first payload is already hydrating when the barrier under test arms.
  ctx.pendingDeliveries++;
  const tick = () => {
    if (stopped) {
      ctx.pendingDeliveries--;
      return;
    }
    // The next payload arrives, then the previous one's slot ends: the counter
    // dips to 1 but never to 0.
    ctx.pendingDeliveries++;
    ctx.pendingDeliveries--;
    ctx.promiseQueue = ctx.promiseQueue.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    );
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return () => {
    stopped = true;
  };
}

describe('delivery-barrier idle safety net vs. unrelated delivery traffic', () => {
  it('retires an abandoned barrier even while other deliveries keep arriving', async () => {
    const ctx = makeCtx();
    const stopStorm = startPokeStorm(ctx);
    try {
      // A branch-deciding delivery the workflow never observes: registered,
      // never marked. Its only way out is the idle net.
      registerDeliveryBarrier(ctx, 0, 'step');

      // A later opposite-kind delivery, gated on it.
      const gated = withResolvers<void>();
      void awaitEarlierDeliveries(ctx, 1, 'hook').then(() => {
        gated.resolve();
      });

      const resolved = await Promise.race([
        gated.promise.then(() => true),
        macrotasks(60).then(() => false),
      ]);

      // Fails on main: the poll re-arms on every tick, so the abandoned
      // barrier is still in the registry and the gated delivery never runs.
      expect(resolved).toBe(true);
    } finally {
      stopStorm();
    }
  });

  it('retires immediately once the traffic stops (control — passes on main)', async () => {
    const ctx = makeCtx();
    const stopStorm = startPokeStorm(ctx);
    registerDeliveryBarrier(ctx, 0, 'step');

    const gated = withResolvers<void>();
    void awaitEarlierDeliveries(ctx, 1, 'hook').then(() => {
      gated.resolve();
    });

    expect(
      await Promise.race([
        gated.promise.then(() => true),
        macrotasks(20).then(() => false),
      ])
    ).toBe(false);

    stopStorm();

    expect(
      await Promise.race([
        gated.promise.then(() => true),
        macrotasks(20).then(() => false),
      ])
    ).toBe(true);
  });

  it('bounds scheduleWhenIdle rather than polling without a deadline', async () => {
    const ctx = makeCtx();
    const stopStorm = startPokeStorm(ctx);
    try {
      let fired = false;
      scheduleWhenIdle(ctx, () => {
        fired = true;
      });

      await macrotasks(60);

      // Fails on main: there is no deadline on the poll, so a caller that
      // needs the callback for liveness has no upper bound at all.
      expect(fired).toBe(true);
    } finally {
      stopStorm();
    }
  });
});
