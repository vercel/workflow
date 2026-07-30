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
 * `scheduleWhenIdle` fires anyway after a bounded number of poll rounds
 * WITHOUT DELIVERY PROGRESS. Both are backstops — the idle condition is still
 * the normal route out, which is what the control test pins.
 *
 * That qualifier is the whole of the second defect this PR fixed. Rounds
 * counted flat bound batch width rather than starvation, because delivering a
 * drain window in log order legitimately costs a round per event; the budget
 * has to measure rounds in which nothing reached workflow code. The three
 * tests at the end of this suite pin the resulting semantics from both sides:
 * it fires on a stall, it does not fire on progress, and progress does not buy
 * permanent immunity — once progress stops the budget starts again.
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

/**
 * A committed step-result delivery, shaped like `step.ts`: barrier and
 * deferral captured while consuming the event, hydration in a serial
 * `promiseQueue` slot, hand-over deferred off the queue behind everything
 * earlier in the log.
 */
function deliverStepResult(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number,
  onDelivered: () => void
): { delivered: Promise<void> } {
  const barrier = registerDeliveryBarrier(ctx, eventIndex, 'step');
  const earlierDelivered = awaitEarlierDeliveries(ctx, eventIndex, 'step');
  const done = withResolvers<void>();
  ctx.pendingDeliveries++;
  ctx.promiseQueue = ctx.promiseQueue.then(() => {
    ctx.pendingDeliveries--;
    void earlierDelivered.then(() => {
      barrier.markDelivered();
      onDelivered();
      done.resolve();
    });
  });
  return { delivered: done.promise };
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

  it('does not fire into the middle of an in-order delivery batch', async () => {
    // The other side of the deadline. It has to bound STARVATION — rounds in
    // which nothing is progressing — and not progress itself.
    //
    // Delivering a drain window in log order costs one macrotask per
    // deferring delivery, so a window of K events takes K rounds to clear.
    // A budget counted in rounds regardless of progress is therefore a cap on
    // BATCH WIDTH: past it the callback fires while deliveries are still
    // landing, and for a hook consumer that callback raises a
    // `WorkflowSuspension` (see the `!event` branch of `workflow/hook.ts`), so
    // the run suspends carrying none of the work the remaining deliveries
    // were about to create.
    //
    // Unlike the other cases in this file, this one passes on `main` — `main`
    // has no deadline to overrun. It guards a regression this PR introduced
    // and then fixed, and it is why the hook scenario of the storm went from
    // 115/600 corrupted to 591/600 on the first two commits of this branch.
    const ctx = makeCtx();
    const delivered: number[] = [];
    let firedAfter: number | null = null;

    // Comfortably wider than the round budget, and narrower than the bursts
    // the hook-storm scenario produces.
    const batch = 40;
    const all = Array.from({ length: batch }, (_, index) =>
      deliverStepResult(ctx, index, () => {
        delivered.push(index);
      })
    );

    // A pending `sleep()` arms one of these on every replay.
    scheduleWhenIdle(ctx, () => {
      firedAfter = delivered.length;
    });

    await Promise.all(all.map((d) => d.delivered));
    // Once the batch is done nothing is in flight, so the poll reaches idle on
    // its next round rather than waiting the budget out; the margin here is
    // for a loaded CI host, not for the deadline.
    await macrotasks(8);

    expect(delivered.length).toBe(batch);
    // The suspension may fire once the batch is done. It may not fire during.
    expect(firedAfter).toBe(batch);
  });

  it('fires once progress stops, having been reset by progress before that', async () => {
    // The third side of the deadline, and the guard on the fix for the second:
    // resetting the budget on progress must not amount to disabling it. A run
    // that delivers for a while and then stalls with traffic still in flight
    // has to reach the callback, or the bound this suite exists to add is gone
    // for every run that ever delivered anything — which is all of them.
    const ctx = makeCtx();
    const storm = startPokeStorm(ctx);
    try {
      // Long enough that the budget is reset many times over: on a flat count
      // this batch alone would exhaust it twice.
      const batch = 32;
      const all = Array.from({ length: batch }, (_, index) =>
        deliverStepResult(ctx, index, () => {})
      );

      let fired = false;
      scheduleWhenIdle(ctx, () => {
        fired = true;
      });

      await Promise.all(all.map((d) => d.delivered));
      // Not during: every round of the batch made progress.
      expect(fired).toBe(false);

      // Now nothing delivers again, but the storm keeps `pendingDeliveries`
      // above zero, so the idle condition can never be met and only the budget
      // can end this.
      await macrotasks(40);
      expect(fired).toBe(true);
      expect(storm.lowWaterMark()).toBeGreaterThan(0);
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
