/**
 * The delivery-barrier registry (`pendingDeliveryBarriers` in `private.ts`)
 * pins branch-deciding delivery order to event-log position. Every barrier
 * also arms a safety net at REGISTRATION time — on `main`, `scheduleWhenIdle`
 * — so a delivery the workflow never observes cannot deadlock a later
 * delivery gated on it.
 *
 * The net's liveness signal is `ctx.pendingDeliveries === 0`, polled on a
 * `setTimeout(0)`. That counter tracks only the HOST-SIDE HYDRATION window:
 * every delivery releases it inside its `promiseQueue` slot, BEFORE the
 * detached continuation that actually hands the value to workflow code — in
 * the `step_completed` branch of `step.ts`,
 *
 *   `ctx.pendingDeliveries--`   (in the hydration `finally`)
 *   `void earlierDelivered.then(() => { markDelivered(); resolve(); })`
 *
 * and likewise in the buffered/awaited hook paths in `workflow/hook.ts`.
 * `workflow/sleep.ts` never touches the counter at all: a `wait_completed`
 * delivery is invisible to it from end to end.
 *
 * So there is a window in which a delivery is armed, committed, and genuinely
 * still in flight — parked inside `awaitEarlierDeliveries`, either on an
 * earlier barrier or on the macrotask yield it pays after gating — while
 * `pendingDeliveries` already reads 0. One idle tick in that window retires
 * EVERY live barrier, including that one. From then on nothing can be ordered
 * behind it: a later delivery reading the registry finds it gone, computes an
 * empty deferral set, skips both the gate and the macrotask yield, and resolves
 * on microtasks — overtaking the branch the parked delivery is about to wake.
 *
 * That is the ordering guarantee collapsing back to the raw hop race the
 * registry exists to remove, and it is invisible to the existing suites: every
 * case in `step-delivery-ordering.test.ts`, `step-delivery-hop-count.test.ts`,
 * and `delivery-barrier-coverage.test.ts` consumes its competing events in ONE
 * drain window, so all the barriers are registered before any of them can
 * retire, and the deferral sets are captured at consumption time.
 *
 * These tests drive the primitives in `private.ts` directly, modelling the
 * delivery mechanics of `step.ts` / `hook.ts` / `sleep.ts` rather than replaying
 * a workflow, because the window is a property of the registry and reproducing
 * it end to end would confound it with drain-window scheduling. They assert the
 * CORRECT behavior — a barrier is retired when its delivery reaches the
 * workflow, or when the delivery is genuinely abandoned, but not while it is in
 * flight.
 *
 * FIXED by retiring on the barrier's own terms instead of a global predicate.
 * The idle check now only retires an UNARMED barrier — an unclaimed buffered
 * hook payload, the one delivery that can be abandoned at the root. Every other
 * barrier is committed: its `markDelivered()` runs from a chain that completes
 * on its own, so the only thing that can hold it up is an earlier unclaimed
 * payload, and retiring that releases it in log order. A deadline bounds the
 * case idle cannot reach; see `delivery-barrier-idle-starvation.test.ts`.
 */
import { withResolvers } from '@workflow/utils';
import { describe, expect, it } from 'vitest';
import {
  awaitEarlierDeliveries,
  type DeliveryKind,
  registerDeliveryBarrier,
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';

/**
 * The registry primitives only read `pendingDeliveryBarriers`,
 * `pendingDeliveries` and `promiseQueue`, so a partial context is enough and
 * keeps the window under test free of VM/consumer scheduling noise.
 */
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
 * Faithful model of a step-result delivery (the `step_completed` branch of
 * `step.ts`): register the barrier and capture the deferral while consuming
 * the event, hydrate inside a serial `promiseQueue` slot, release
 * `pendingDeliveries` at the END of that slot, and only then defer — off the
 * queue — before handing the value over.
 *
 * `onDelivered` stands in for the workflow continuation that `resolve()` wakes,
 * i.e. the branch that goes on to draw the next `useStep` ULID.
 *
 * `hydration` is how long the slot takes: a number of milliseconds, or a
 * promise to await when a test needs the window held open deterministically
 * rather than by the clock.
 */
function deliverStepResult(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number,
  onDelivered: () => void,
  hydration: number | Promise<void> = 0
): { delivered: Promise<void> } {
  const barrier = registerDeliveryBarrier(ctx, eventIndex, 'step');
  const earlierDelivered = awaitEarlierDeliveries(ctx, eventIndex, 'step');
  const done = withResolvers<void>();
  ctx.pendingDeliveries++;
  ctx.promiseQueue = ctx.promiseQueue.then(async () => {
    try {
      if (typeof hydration === 'number') {
        if (hydration > 0) {
          await new Promise((r) => setTimeout(r, hydration));
        }
      } else {
        await hydration;
      }
    } finally {
      ctx.pendingDeliveries--;
    }
    void earlierDelivered.then(() => {
      barrier.markDelivered();
      onDelivered();
      done.resolve();
    });
  });
  return { delivered: done.promise };
}

/**
 * Model of a delivery consumed in a LATER drain window than the one above — a
 * `wait_completed` (`workflow/sleep.ts`) or a hook payload with a waiting
 * consumer (`workflow/hook.ts`). It reads the registry when its own event is
 * consumed, which is after the earlier delivery's barrier may already have
 * retired.
 */
function deliverLater(
  ctx: WorkflowOrchestratorContext,
  eventIndex: number,
  kind: Exclude<DeliveryKind, 'step'>,
  onDelivered: () => void
): { delivered: Promise<void> } {
  const barrier = registerDeliveryBarrier(ctx, eventIndex, kind);
  const earlierDelivered = awaitEarlierDeliveries(ctx, eventIndex, kind);
  const done = withResolvers<void>();
  void ctx.promiseQueue
    .then(() => earlierDelivered)
    .then(() => {
      barrier.markDelivered();
      onDelivered();
      done.resolve();
    });
  return { delivered: done.promise };
}

describe('delivery-barrier safety net vs. in-flight deliveries', () => {
  it('keeps a barrier registered while its delivery is parked in awaitEarlierDeliveries', async () => {
    const ctx = makeCtx();
    const barriers = ctx.pendingDeliveryBarriers!;

    // index 0: an earlier wait delivery, armed and self-resolving.
    const wait = registerDeliveryBarrier(ctx, 0, 'wait');
    // index 1: a step result that must be handed over after the wait, so it
    // parks on the gate and then on the macrotask yield awaitEarlierDeliveries
    // pays after gating.
    let stepDelivered = false;
    registerDeliveryBarrier(ctx, 1, 'step');
    const stepDeferral = awaitEarlierDeliveries(ctx, 1, 'step');
    void stepDeferral.then(() => {
      stepDelivered = true;
    });

    // The wait reaches the workflow, releasing the step's gate. The step is now
    // parked on the macrotask yield: committed, in flight, not yet delivered.
    wait.markDelivered();

    // One idle tick. Nothing is hydrating — exactly the state a run reaches
    // between a hydration slot ending (the `pendingDeliveries--` in step.ts's
    // `finally`) and the detached continuation running.
    await macrotask();

    // Precondition for this test to mean anything: the step really has not been
    // handed to workflow code yet.
    expect(stepDelivered).toBe(false);

    // FAILS on `main`: the idle net ran `finish()` for a delivery that is
    // still in flight, so nothing consumed from here on can be ordered behind
    // it.
    expect(barriers.has(1)).toBe(true);
  });

  it('does not let a later delivery overtake an earlier one the idle tick retired', async () => {
    const ctx = makeCtx();
    const order: string[] = [];

    // Drain window 1 — the log ordered the wait at index 0 before the step
    // result at index 1, so the step defers behind it.
    const wait = registerDeliveryBarrier(ctx, 0, 'wait');
    let stepBranchHops = 0;
    const step = deliverStepResult(ctx, 1, () => {
      order.push('step@1');
      // The woken branch needs a few more hops before it draws its next ULID —
      // `for await` over a hook, an intermediate `await`, anything. The
      // macrotask yield the step paid exists precisely so this can finish
      // before a later delivery lands.
      void (async () => {
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
          stepBranchHops++;
        }
        order.push('step@1:drew-ulid');
      })();
    });
    wait.markDelivered();

    // The idle tick lands here, retiring the step's still-parked barrier.
    await macrotask();

    // Drain window 2 — a later-in-log delivery is consumed and reads the
    // registry now. Log order says it must reach the workflow after index 1.
    const later = deliverLater(ctx, 2, 'wait', () => {
      order.push('wait@2');
    });

    await Promise.all([step.delivered, later.delivered]);
    await macrotasks(3);

    expect(stepBranchHops).toBe(8);
    // FAILS on `main`: index 1's barrier was retired by the idle tick, so
    // index 2 computed an empty deferral set, skipped the macrotask yield, and
    // resolved on microtasks — reaching workflow code before the branch index 1
    // woke got to draw its ULID. In a real run those two branches are the two
    // `useStep` calls whose correlation IDs swap, which is the
    // `ReplayDivergenceError` at a `step_created`.
    expect(order).toEqual(['step@1', 'step@1:drew-ulid', 'wait@2']);
  });

  it('retires every live barrier on a single idle tick, not just abandoned ones', async () => {
    const ctx = makeCtx();
    const barriers = ctx.pendingDeliveryBarriers!;

    // A fan-out of concurrent branches, the shape the `pendingDeliveryBarriers`
    // docs describe: one barrier per branch per kind, accumulated in a single drain
    // window because `EventsConsumer` drains consecutively consumable events
    // synchronously while barriers only retire on microtask-driven deliveries.
    const gate = registerDeliveryBarrier(ctx, 0, 'wait');
    const parked: Promise<void>[] = [];
    for (let index = 1; index <= 5; index++) {
      registerDeliveryBarrier(ctx, index, 'step');
      parked.push(awaitEarlierDeliveries(ctx, index, 'step'));
    }
    expect(barriers.size).toBe(6);

    let deliveredCount = 0;
    for (const p of parked) {
      void p.then(() => {
        deliveredCount++;
      });
    }

    gate.markDelivered();
    await macrotask();

    // All five step deliveries are still parked on the macrotask yield…
    expect(deliveredCount).toBe(0);
    // …but on `main` the registry is already empty, so the ordering guarantee
    // for every one of them is gone at once. FAILS on `main` (size 0).
    expect(barriers.size).toBe(5);
  });

  it('does not retire an armed barrier on the abandon deadline, however slow its hydration', async () => {
    // The deadline that bounds the starvation case must not become a slower
    // rerun of the collapse this file documents. It applies to UNARMED
    // barriers only, so a committed delivery is immune to it no matter how
    // long it takes — which matters because in production slow hydration is
    // the ordinary case, not a pathological one: a payload fetched from
    // object storage and decrypted takes 10-500ms, while the deadline is a
    // few dozen `setTimeout(0)` ticks. Without this test the rule would be
    // unguarded, since no other case here hydrates for longer than a tick.
    const ctx = makeCtx();
    const barriers = ctx.pendingDeliveryBarriers!;
    const order: string[] = [];
    // An explicit gate rather than a sleep, so the test measures the rule and
    // not the machine it runs on.
    const hydrating = withResolvers<void>();

    const step = deliverStepResult(
      ctx,
      0,
      () => {
        order.push('step@0');
        void (async () => {
          for (let i = 0; i < 8; i++) {
            await Promise.resolve();
          }
          order.push('step@0:drew-ulid');
        })();
      },
      hydrating.promise
    );

    // Well past the deadline, with the delivery committed and still in flight.
    await macrotasks(48);
    expect(ctx.pendingDeliveries).toBe(1);
    expect(barriers.has(0)).toBe(true);

    // A later-in-log delivery consumed while the slow one is still hydrating
    // still has to be ordered behind it.
    const later = deliverLater(ctx, 1, 'wait', () => {
      order.push('wait@1');
    });
    hydrating.resolve();

    await Promise.all([step.delivered, later.delivered]);
    await macrotasks(3);

    expect(order).toEqual(['step@0', 'step@0:drew-ulid', 'wait@1']);
  });
});

/**
 * The same ordering hole reached without the idle net, so it stands on its own.
 *
 * A barrier is retired by `markDelivered()`, which `step.ts`, `workflow/hook.ts`
 * and `workflow/sleep.ts` all call in the SAME callback as the `resolve()` that hands
 * the value to workflow code — one statement earlier. "Delivered" therefore
 * means "resolve() ran", not "the branch that resolve() woke reached its next
 * suspension point", which is what the macrotask yield in
 * `awaitEarlierDeliveries` exists to wait for (its own comment says so: the
 * woken branch "may need an
 * arbitrary number of further microtask hops before it reaches its next
 * `useStep` call and draws a ULID").
 *
 * So between `markDelivered()` and that branch quiescing there is a window in
 * which the registry no longer mentions the delivery. Any delivery that reads
 * the registry inside it — one consumed in a later drain window, or a buffered
 * hook payload whose `claim()` evaluates its deferral at claim time
 * (`claim()` in `workflow/hook.ts`, the one delivery that deliberately does NOT capture at
 * consumption time) — computes an empty deferral set, skips the yield, and
 * resolves on microtasks. It then draws its ULID first even though the log
 * ordered it second.
 *
 * FIXED by keeping a retired delivery visible to the registry for one more
 * macrotask — the same yield a deferring delivery would have paid — in
 * `recentlyDeliveredBarriers`. The live registry drops the entry immediately,
 * as this test asserts; ordering visibility outlives it just long enough for
 * the woken branch to reach its next suspension point.
 */
describe('delivery-barrier retirement vs. the woken branch quiescing', () => {
  it('does not let a later delivery overtake the continuation an earlier one woke', async () => {
    const ctx = makeCtx();
    const order: string[] = [];

    // index 0: a step result with nothing earlier in the log, so it defers
    // behind nothing and is handed over as soon as its hydration slot ends.
    const step = deliverStepResult(ctx, 0, () => {
      order.push('step@0');
      // The branch it woke needs several more hops before its next `useStep`.
      void (async () => {
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        order.push('step@0:drew-ulid');
      })();
    });

    // `markDelivered()` has now run and index 0 is out of the registry, but the
    // branch is still mid-continuation.
    await step.delivered;
    expect(ctx.pendingDeliveryBarriers!.has(0)).toBe(false);

    // A later-in-log delivery is consumed here and reads the registry.
    const later = deliverLater(ctx, 1, 'wait', () => {
      order.push('wait@1');
    });

    await later.delivered;
    await macrotasks(3);

    // FAILS on `main`: index 1 found an empty registry, so it neither gated on
    // index 0 nor paid the macrotask yield, and its branch drew a ULID before
    // the branch index 0 woke did — the wake-order inversion that renames the
    // trailing `step_created` events.
    expect(order).toEqual(['step@0', 'step@0:drew-ulid', 'wait@1']);
  });

  it('does not observe idle while a delivery is parked on a quiescing entry', async () => {
    // The cost of the window above: a delivery whose only remaining gate is a
    // quiescing entry is in flight, but neither `pendingDeliveries` (released
    // in the hydration slot) nor a scan of the live registry (already empty)
    // can see it. A suspension raised there preempts the delivery, and the run
    // suspends carrying none of the work it was about to create. Caught by the
    // `hookWithSleepWorkflow` e2e, whose second hook payload went missing:
    // `claim()` evaluates its deferral late, so a quiescing entry is exactly
    // the gate it ends up on.
    const ctx = makeCtx();
    const order: string[] = [];

    // An earlier delivery, just handed over: out of the live registry, still
    // quiescing.
    registerDeliveryBarrier(ctx, 0, 'step').markDelivered();
    expect(ctx.pendingDeliveryBarriers!.size).toBe(0);
    expect(ctx.pendingDeliveries).toBe(0);

    const parked = awaitEarlierDeliveries(ctx, 1, 'hook').then(() => {
      order.push('delivered');
    });
    // A suspension armed in that window — a pending `sleep()` arms one on
    // every replay.
    scheduleWhenIdle(ctx, () => {
      order.push('suspended');
    });

    await parked;
    await macrotasks(6);

    expect(order).toEqual(['delivered', 'suspended']);
  });
});
