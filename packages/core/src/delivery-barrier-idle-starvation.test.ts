/**
 * The inverse failure of `delivery-barrier-idle-collapse.test.ts`.
 *
 * A barrier registered by `registerDeliveryBarrier` has exactly two retirement
 * paths: `markDelivered()`, called when the delivery reaches workflow code, and
 * the safety net armed at registration. For the one delivery that can be
 * abandoned at the root — a buffered hook payload no consumer ever claims —
 * the net is the ONLY path, and a later wait or hook delivery gated on that
 * payload cannot be handed over until the net fires.
 *
 * On `main` that net was `scheduleWhenIdle`, an unbounded poll:
 *
 *     const check = () => {
 *       if (ctx.pendingDeliveries > 0) {
 *         ctx.promiseQueue.then(() => { setTimeout(check, 0); });
 *       } else { fn(); }
 *     };
 *     setTimeout(check, 0);
 *
 * No deadline, no iteration cap, no escape: while any unrelated delivery is in
 * the host-side hydration window, every armed net re-schedules itself.
 * `pendingDeliveries` is a single global counter, so the traffic keeping it
 * non-zero need not have anything to do with the barrier waiting on it.
 *
 * What this suite does and does not claim. It models SUSTAINED traffic —
 * consumption starting a new hydration before the previous slot ends, so the
 * counter never touches zero — and shows that under that condition the poll
 * has no way out. It does NOT prove that a production run sustains it
 * indefinitely: a finite burst drains, and a replay of N buffered payloads
 * retires every barrier in milliseconds once consumption stops. The live
 * observation that motivated the suite (a run making no progress for 3m19s
 * across 228 deliveries to a never-read poke hook, with later runs in the same
 * shape dying at REPLAY_TIMEOUT) is consistent with this mechanism but is not
 * established by it; attributing that run needs a trace of its own. The
 * deadline is justified as a bound on a loop that provably has none, not as a
 * diagnosis of that run.
 *
 * `startPokeStorm` below therefore holds the counter above zero with genuinely
 * overlapping deliveries and no unmatched increment — every `++` has a `--`
 * that lands one tick later, so the storm leaks nothing and the counter
 * returns to zero on its own once it stops. The control test asserts both
 * halves of that, because a harness that pinned the counter with a leak would
 * be modelling a stuck hydration (a hang in its own right) rather than
 * traffic.
 *
 * FIXED by giving both polls a deadline. An unclaimed payload's barrier
 * retires after a bounded number of ticks whatever the traffic, and
 * `scheduleWhenIdle` fires anyway after a bounded number of poll rounds. Both
 * are backstops — the idle condition is still the normal route out, which is
 * what the control test pins.
 *
 * The deadline deliberately does NOT apply to an ARMED barrier. Those are
 * committed deliveries with unconditional chains, and force-retiring one on a
 * timer would re-create the collapse this suite's sibling documents, at
 * production hydration latency; see `scheduleBarrierRetirement` and the
 * slow-hydration test in `delivery-barrier-idle-collapse.test.ts`.
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

interface PokeStorm {
  stop: () => void;
  /** Lowest value `pendingDeliveries` reached while the storm ran. */
  lowWaterMark: () => number;
}

/**
 * Models a continuous stream of deliveries for a hook the workflow never
 * reads. Each poke's hydration spans two ticks and the next poke arrives
 * before the previous one's slot ends, so `pendingDeliveries` oscillates
 * between 1 and 2 and never touches zero — without any unmatched increment.
 * The ordering matters: the next arrival is scheduled BEFORE the previous
 * slot's release, which is what produces the overlap rather than a 1 → 0 → 1
 * dip. Each arrival also extends `promiseQueue`, which is what keeps an armed
 * `scheduleWhenIdle` poll spinning rather than stalling.
 *
 * This is the poke cadence of the step-storm repro: an out-of-band resume
 * every ~750ms against a run whose hydration takes longer than that produces
 * exactly this overlap for as long as the pokes keep landing.
 */
function startPokeStorm(ctx: WorkflowOrchestratorContext): PokeStorm {
  let stopped = false;
  let low = Number.POSITIVE_INFINITY;
  const bump = (delta: number) => {
    ctx.pendingDeliveries += delta;
    low = Math.min(low, ctx.pendingDeliveries);
  };
  const tick = () => {
    if (stopped) {
      return;
    }
    // A payload arrives and begins hydrating.
    bump(1);
    // The next one arrives first…
    setTimeout(tick, 0);
    // …and only then does this one's slot end.
    setTimeout(() => bump(-1), 0);
    ctx.promiseQueue = ctx.promiseQueue.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    );
  };
  tick();
  return {
    stop: () => {
      stopped = true;
    },
    lowWaterMark: () => low,
  };
}

/** A buffered hook payload nobody has claimed: the abandonable delivery. */
function registerUnclaimedPayload(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number
): void {
  registerDeliveryBarrier(ctx, eventIndex, 'hook', { armed: false });
}

describe('delivery-barrier safety net vs. unrelated delivery traffic', () => {
  it('retires an unclaimed payload even while other deliveries keep arriving', async () => {
    const ctx = makeCtx();
    const storm = startPokeStorm(ctx);
    try {
      // A payload the workflow never reads: registered, never claimed, never
      // marked. Its only way out is the safety net.
      registerUnclaimedPayload(ctx, 0);

      // A later wait, which per DEFER_BEHIND gates on it.
      const gated = withResolvers<void>();
      void awaitEarlierDeliveries(ctx, 1, 'wait').then(() => {
        gated.resolve();
      });

      const resolved = await Promise.race([
        gated.promise.then(() => true),
        macrotasks(60).then(() => false),
      ]);

      // Fails on `main`: the poll re-arms on every tick, so the unclaimed
      // payload is still in the registry and the gated wait never runs.
      expect(resolved).toBe(true);
      // The storm really did keep hydration busy throughout.
      expect(storm.lowWaterMark()).toBeGreaterThan(0);
    } finally {
      storm.stop();
    }
  });

  it('retires on the idle condition once the traffic stops (control)', async () => {
    const ctx = makeCtx();
    const storm = startPokeStorm(ctx);
    registerUnclaimedPayload(ctx, 0);

    const gated = withResolvers<void>();
    void awaitEarlierDeliveries(ctx, 1, 'wait').then(() => {
      gated.resolve();
    });

    // Still gated well before the deadline could have fired.
    expect(
      await Promise.race([
        gated.promise.then(() => true),
        macrotasks(20).then(() => false),
      ])
    ).toBe(false);
    expect(storm.lowWaterMark()).toBeGreaterThan(0);

    storm.stop();

    // Far fewer ticks than the deadline has left, so reaching the workflow
    // here is the idle condition doing it, not the backstop.
    expect(
      await Promise.race([
        gated.promise.then(() => true),
        macrotasks(8).then(() => false),
      ])
    ).toBe(true);
    // And the storm drained itself: no leaked increment was holding the
    // counter up, which is what makes the first assertion above meaningful.
    expect(ctx.pendingDeliveries).toBe(0);
  });

  it('bounds scheduleWhenIdle rather than polling without a deadline', async () => {
    const ctx = makeCtx();
    const storm = startPokeStorm(ctx);
    try {
      let fired = false;
      scheduleWhenIdle(ctx, () => {
        fired = true;
      });

      await macrotasks(60);

      // Fails on `main`: there is no deadline on the poll, so a caller that
      // needs the callback for liveness — a `WorkflowSuspension`, in the
      // engine — has no upper bound at all.
      expect(fired).toBe(true);
    } finally {
      storm.stop();
    }
  });

  it('drains a fan-out of unclaimed payloads gating a later delivery', async () => {
    // The liveness direction, and the guard on this whole fix: holding
    // barriers longer must not turn "many unclaimed payloads" into a stall.
    // 228 is the count from the live step-storm observation. On `main` this
    // passes in single-digit milliseconds; it must stay that way.
    const ctx = makeCtx();
    for (let index = 0; index < 228; index++) {
      registerUnclaimedPayload(ctx, index);
    }

    const gated = withResolvers<void>();
    void awaitEarlierDeliveries(ctx, 228, 'wait').then(() => {
      gated.resolve();
    });

    // A handful of ticks for the whole fan-out — not one per barrier, and
    // nowhere near the abandon deadline.
    expect(
      await Promise.race([
        gated.promise.then(() => true),
        macrotasks(8).then(() => false),
      ])
    ).toBe(true);
    expect(ctx.pendingDeliveryBarriers?.size).toBe(0);
  });
});
