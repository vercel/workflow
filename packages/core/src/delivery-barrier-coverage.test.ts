/**
 * Third companion to `step-delivery-ordering.test.ts` (the two production
 * `CORRUPTED_EVENT_LOG` shapes) and `step-delivery-hop-count.test.ts` (a step
 * result must not overtake the wait/hook branch the log ordered first, however
 * many hops that branch needs). Both of those cover a step result deferring
 * behind an earlier delivery. This file covers the three cases where the
 * delivery-barrier registry did not yet reach:
 *
 *  1. STEP behind STEP, across drain windows. `DEFER_BEHIND.step` used to
 *     exclude `'step'`, on the grounds that the serial `promiseQueue` already
 *     orders step results. It no longer does: a step captures its outcome in
 *     its queue slot but resolves from a detached continuation once its
 *     barrier clears, and two steps agree on that ordering only while they
 *     defer behind the same set.
 *
 *  2. WAIT / HOOK behind STEP, at varying consumer hop counts — the mirror of
 *     `step-delivery-hop-count.test.ts`. `sleep.ts` and `hook.ts` used to read
 *     the registry after their queue work rather than at event-consumption
 *     time, by which point an earlier step had usually delivered and retired
 *     its barrier. They then skipped both the gate and
 *     `awaitEarlierDeliveries`' macrotask yield.
 *
 *  3. HOOK behind HOOK. Adjacent payloads for independently awaited hooks
 *     must reach their consumers in log order even when the earlier consumer
 *     takes more microtask hops to act on its value.
 *
 *  4. ABORT deliveries. `_setAborted` fires the signal's listeners, and a
 *     listener may invoke a step and draw a ULID, so an abort is as
 *     branch-deciding as any other delivery — but it resolved straight off its
 *     `promiseQueue` slot and registered no barrier.
 *
 * Cases 1-4 assert the same thing: the replay allocates its follow-up step
 * ULIDs in the order the committed log recorded. A regression surfaces as the
 * production `ReplayDivergenceError`.
 *
 * Section 5 asserts the registry's other job directly, over a registry built
 * by hand rather than by a replay: which entries an idle check may ignore. Get
 * that wrong in one direction and a chain parked on an unclaimed hook payload
 * deadlocks; wrong in the other and a suspension preempts a batch of parked
 * step results.
 *
 * The final section covers the SUSPENSION side of the registry
 * (vercel/workflow#3183): an idle check must not observe idle — and raise a
 * `WorkflowSuspension` — while a delivery that is committed to reaching the
 * workflow is still parked between its queue slot (which releases
 * `pendingDeliveries`) and its detached `resolve()` (which pays
 * `awaitEarlierDeliveries`' macrotask yield whenever it deferred). A
 * suspension raised inside that gap predates the workflow's own
 * continuations, carries none of the follow-up work they were about to
 * create, and schedules nothing — leaving the run dormant.
 */
import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateAbortController } from './workflow/abort-controller.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

const FIXED_TIMESTAMP = 1753481739458;

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  // Real-session parity: the log-order-draws quiescence fixpoint keys its
  // progress metric on `mintCount`; without it the loop degrades to a single
  // turn and this suite would only exercise a degraded variant.
  let mintCount = 0;
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    suspensionGeneration: 0,
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      // Fake context: no deliveries are modeled, so the gate is a no-op here.
      isDeliveryIdle: () => true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(`Unconsumed event: ${event.eventType}`)
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => {
      mintCount += 1;
      return ulid(workflowStartedAt);
    },
    get mintCount() {
      return mintCount;
    },
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
  ctxRef.current = ctx;
  return ctx;
}

/**
 * The ULIDs the seeded generator hands out, in invocation order. Correlation
 * IDs in the fixtures below have to match what the replayed workflow draws.
 */
function deterministicUlids(count: number): string[] {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: FIXED_TIMESTAMP,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return Array.from({ length: count }, () => ulid(workflowStartedAt));
}

const ULIDS = deterministicUlids(8);

async function replay(
  ctx: WorkflowOrchestratorContext,
  workflowFn: () => Promise<unknown>
): Promise<unknown> {
  const discontinuation = withResolvers<void>();
  ctx.onWorkflowError = discontinuation.reject;
  try {
    await Promise.race([workflowFn(), discontinuation.promise]);
  } catch (err) {
    return err;
  }
  return undefined;
}

/**
 * Assert the replay stopped where the committed log says it should: the
 * follow-up steps allocated, in the log's order, and the run suspended waiting
 * on them. A divergent replay fails here with the production error instead.
 */
function expectSuspendedWithPendingSteps(
  ctx: WorkflowOrchestratorContext,
  error: unknown,
  expected: string[]
) {
  if (!WorkflowSuspension.is(error)) {
    throw new Error(
      error === undefined
        ? 'expected the replay to suspend, but it completed'
        : error instanceof Error
          ? error.message
          : String(error),
      { cause: error }
    );
  }
  expect(
    [...ctx.invocationsQueue.values()].flatMap((item) =>
      item.type === 'step' ? [item.stepName] : []
    )
  ).toEqual(expected);
}

const event = (
  eventId: string,
  eventType: string,
  correlationId: string,
  eventData: Record<string, unknown>
): Event =>
  ({
    eventId,
    runId: 'wrun_test',
    eventType,
    correlationId,
    eventData,
    createdAt: new Date(),
  }) as Event;

// ─── 1. step behind step, across drain windows ────────────────────────────
//
// The log is one a live run legitimately produces:
//
//   evnt_3  wait_completed        ← the sleep branch
//   evnt_4  step_completed stepA  ← stepA's worker wrote this just before…
//   evnt_5  step_created   stepB  ← …the invocation resuming from the sleep
//                                   wrote this; its own replay predated
//                                   evnt_4, so it never delivered stepA
//   evnt_7  step_completed stepB
//   evnt_8  step_created   afterA ← a later invocation delivered stepA first,
//   evnt_9  step_created   afterB   exactly as the log orders them
//
// On replay `stepB`'s consumer does not exist until the sleep is delivered, so
// the drain stops at evnt_5 and the two step completions land in separate
// windows. stepA (deferring behind the wait) is then parked on the macrotask
// yield while stepB, which sees an empty registry, resolves on microtasks.
describe('step result delivery ordering against an earlier step result', () => {
  it('delivers the earlier step_completed first when only it defers', async () => {
    const resumeAt = new Date(FIXED_TIMESTAMP + 5_000);
    const ops: Promise<unknown>[] = [];
    const [stepAResult, stepBResult] = await Promise.all([
      dehydrateStepReturnValue('a', 'wrun_test', undefined, ops),
      dehydrateStepReturnValue('b', 'wrun_test', undefined, ops),
    ]);

    const events: Event[] = [
      event('evnt_0', 'step_created', `step_${ULIDS[0]}`, {
        stepName: 'stepA',
      }),
      event('evnt_1', 'wait_created', `wait_${ULIDS[1]}`, { resumeAt }),
      event('evnt_2', 'step_started', `step_${ULIDS[0]}`, {
        stepName: 'stepA',
      }),
      event('evnt_3', 'wait_completed', `wait_${ULIDS[1]}`, { resumeAt }),
      event('evnt_4', 'step_completed', `step_${ULIDS[0]}`, {
        stepName: 'stepA',
        result: stepAResult,
      }),
      event('evnt_5', 'step_created', `step_${ULIDS[2]}`, {
        stepName: 'stepB',
      }),
      event('evnt_6', 'step_started', `step_${ULIDS[2]}`, {
        stepName: 'stepB',
      }),
      event('evnt_7', 'step_completed', `step_${ULIDS[2]}`, {
        stepName: 'stepB',
        result: stepBResult,
      }),
      event('evnt_8', 'step_created', `step_${ULIDS[3]}`, {
        stepName: 'afterA',
      }),
      event('evnt_9', 'step_created', `step_${ULIDS[4]}`, {
        stepName: 'afterB',
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);

    const error = await replay(ctx, async () => {
      const stepA = useStep('stepA');
      const afterA = useStep('afterA');
      const stepB = useStep('stepB');
      const afterB = useStep('afterB');

      await Promise.all([
        (async () => {
          await stepA();
          await afterA();
        })(),
        (async () => {
          await sleep('5s');
          await stepB();
          await afterB();
        })(),
      ]);
    });

    expectSuspendedWithPendingSteps(ctx, error, ['afterA', 'afterB']);
  });
});

// ─── 2. wait / hook behind step, at varying consumer hop counts ────────────
//
// The mirror of `step-delivery-hop-count.test.ts`: there a step result must
// not overtake an earlier wait/hook branch; here a wait/hook must not overtake
// an earlier STEP branch. The step branch is padded with extra `await`s so hop
// count is the only variable — under a hop-count race the padded branch loses
// and the follow-up ULIDs swap.
const EXTRA_HOPS = [0, 1, 3, 8, 20, 50];

describe('wait completion delivery ordering against an earlier step result', () => {
  for (const extraHops of EXTRA_HOPS) {
    it(`keeps the recorded ULID allocation with ${extraHops} extra consumer hops`, async () => {
      const resumeAt = new Date(FIXED_TIMESTAMP + 5_000);
      const ops: Promise<unknown>[] = [];
      const stepAResult = await dehydrateStepReturnValue(
        'a',
        'wrun_test',
        undefined,
        ops
      );

      const events: Event[] = [
        event('evnt_0', 'step_created', `step_${ULIDS[0]}`, {
          stepName: 'stepA',
        }),
        event('evnt_1', 'wait_created', `wait_${ULIDS[1]}`, { resumeAt }),
        event('evnt_2', 'step_started', `step_${ULIDS[0]}`, {
          stepName: 'stepA',
        }),
        event('evnt_3', 'step_completed', `step_${ULIDS[0]}`, {
          stepName: 'stepA',
          result: stepAResult,
        }),
        event('evnt_4', 'wait_completed', `wait_${ULIDS[1]}`, { resumeAt }),
        event('evnt_5', 'step_created', `step_${ULIDS[2]}`, {
          stepName: 'afterStep',
        }),
        event('evnt_6', 'step_created', `step_${ULIDS[3]}`, {
          stepName: 'afterSleep',
        }),
      ];

      const ctx = setupWorkflowContext(events);
      const useStep = createUseStep(ctx);
      const sleep = createSleep(ctx);

      const error = await replay(ctx, async () => {
        const stepA = useStep('stepA');
        const afterStep = useStep('afterStep');
        const afterSleep = useStep('afterSleep');

        await Promise.all([
          (async () => {
            await stepA();
            for (let i = 0; i < extraHops; i++) {
              await Promise.resolve();
            }
            await afterStep();
          })(),
          (async () => {
            await sleep('5s');
            await afterSleep();
          })(),
        ]);
      });

      expectSuspendedWithPendingSteps(ctx, error, ['afterStep', 'afterSleep']);
    });
  }
});

describe('hook payload delivery ordering against an earlier step result', () => {
  for (const extraHops of EXTRA_HOPS) {
    it(`keeps the recorded ULID allocation with ${extraHops} extra consumer hops`, async () => {
      const ops: Promise<unknown>[] = [];
      const [stepAResult, hookPayload] = await Promise.all([
        dehydrateStepReturnValue('a', 'wrun_test', undefined, ops),
        dehydrateStepReturnValue({ v: 1 }, 'wrun_test', undefined, ops),
      ]);

      const events: Event[] = [
        event('evnt_0', 'step_created', `step_${ULIDS[0]}`, {
          stepName: 'stepA',
        }),
        event('evnt_1', 'hook_created', `hook_${ULIDS[1]}`, {
          token: 'tok',
          isWebhook: false,
        }),
        event('evnt_2', 'step_started', `step_${ULIDS[0]}`, {
          stepName: 'stepA',
        }),
        event('evnt_3', 'step_completed', `step_${ULIDS[0]}`, {
          stepName: 'stepA',
          result: stepAResult,
        }),
        event('evnt_4', 'hook_received', `hook_${ULIDS[1]}`, {
          token: 'tok',
          payload: hookPayload,
        }),
        event('evnt_5', 'step_created', `step_${ULIDS[2]}`, {
          stepName: 'afterStep',
        }),
        event('evnt_6', 'step_created', `step_${ULIDS[3]}`, {
          stepName: 'afterHook',
        }),
      ];

      const ctx = setupWorkflowContext(events);
      const useStep = createUseStep(ctx);
      const createHook = createCreateHook(ctx);

      const error = await replay(ctx, async () => {
        const stepA = useStep('stepA');
        const afterStep = useStep('afterStep');
        const afterHook = useStep('afterHook');

        await Promise.all([
          (async () => {
            await stepA();
            for (let i = 0; i < extraHops; i++) {
              await Promise.resolve();
            }
            await afterStep();
          })(),
          (async () => {
            const hook = createHook<{ v: number }>({ token: 'tok' });
            await hook;
            await afterHook();
          })(),
        ]);
      });

      expectSuspendedWithPendingSteps(ctx, error, ['afterStep', 'afterHook']);
    });
  }
});

// ─── 3. hook behind hook, across different consumer shapes ─────────────────
describe('hook payload delivery ordering against an earlier hook payload', () => {
  it('keeps the recorded ULID allocation when the earlier hook uses an async iterator', async () => {
    const ops: Promise<unknown>[] = [];
    const [firstPayload, secondPayload] = await Promise.all([
      dehydrateStepReturnValue({ v: 1 }, 'wrun_test', undefined, ops),
      dehydrateStepReturnValue({ v: 2 }, 'wrun_test', undefined, ops),
    ]);

    const events: Event[] = [
      event('evnt_0', 'hook_created', `hook_${ULIDS[0]}`, {
        token: 'first',
        isWebhook: false,
      }),
      event('evnt_1', 'hook_created', `hook_${ULIDS[1]}`, {
        token: 'second',
        isWebhook: false,
      }),
      event('evnt_2', 'hook_received', `hook_${ULIDS[0]}`, {
        token: 'first',
        payload: firstPayload,
      }),
      event('evnt_3', 'hook_received', `hook_${ULIDS[1]}`, {
        token: 'second',
        payload: secondPayload,
      }),
      event('evnt_4', 'step_created', `step_${ULIDS[2]}`, {
        stepName: 'afterFirst',
      }),
      event('evnt_5', 'step_created', `step_${ULIDS[3]}`, {
        stepName: 'afterSecond',
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const createHook = createCreateHook(ctx);

    const error = await replay(ctx, async () => {
      const first = createHook<{ v: number }>({ token: 'first' });
      const second = createHook<{ v: number }>({ token: 'second' });
      const afterFirst = useStep('afterFirst');
      const afterSecond = useStep('afterSecond');

      await Promise.all([
        (async () => {
          for await (const payload of first) {
            void payload;
            // Model a layered hook consumer such as an async inbox merger:
            // the delivery order must survive its continuation depth.
            for (let i = 0; i < 16; i++) {
              await Promise.resolve();
            }
            await afterFirst();
            break;
          }
        })(),
        (async () => {
          await second;
          await afterSecond();
        })(),
      ]);
    });

    expectSuspendedWithPendingSteps(ctx, error, ['afterFirst', 'afterSecond']);
  });
});

// ─── 4. abort deliveries ───────────────────────────────────────────────────
//
//   evnt_4  wait_completed          ← makes the step result defer
//   evnt_5  step_completed stepA    ← deferred behind the wait
//   evnt_6  hook_received  (abort)  ← must NOT overtake evnt_5
describe('abort delivery ordering against an earlier step result', () => {
  it('delivers the earlier step_completed before the abort', async () => {
    // The controller draws two ULIDs on construction (stream id, then hook
    // correlation id), so the sleep and stepA take the next two.
    const abortHookToken = `abrt_${ULIDS[0]}`;
    const abortCorrelationId = `hook_${ULIDS[1]}`;
    const waitCorrelationId = `wait_${ULIDS[2]}`;
    const stepACorrelationId = `step_${ULIDS[3]}`;

    const resumeAt = new Date(FIXED_TIMESTAMP + 5_000);
    const ops: Promise<unknown>[] = [];
    const [stepAResult, abortPayload] = await Promise.all([
      dehydrateStepReturnValue('a', 'wrun_test', undefined, ops),
      dehydrateStepReturnValue(
        { reason: 'cancelled' },
        'wrun_test',
        undefined,
        ops
      ),
    ]);

    const events: Event[] = [
      event('evnt_0', 'hook_created', abortCorrelationId, {
        token: abortHookToken,
        isWebhook: false,
      }),
      event('evnt_1', 'wait_created', waitCorrelationId, { resumeAt }),
      event('evnt_2', 'step_created', stepACorrelationId, {
        stepName: 'stepA',
      }),
      event('evnt_3', 'step_started', stepACorrelationId, {
        stepName: 'stepA',
      }),
      event('evnt_4', 'wait_completed', waitCorrelationId, { resumeAt }),
      event('evnt_5', 'step_completed', stepACorrelationId, {
        stepName: 'stepA',
        result: stepAResult,
      }),
      event('evnt_6', 'hook_received', abortCorrelationId, {
        token: abortHookToken,
        payload: abortPayload,
      }),
      event('evnt_7', 'step_created', `step_${ULIDS[4]}`, {
        stepName: 'afterStep',
      }),
      event('evnt_8', 'step_created', `step_${ULIDS[5]}`, {
        stepName: 'afterAbort',
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);
    const WorkflowAbortController = createCreateAbortController(ctx);

    const error = await replay(ctx, async () => {
      const controller = new WorkflowAbortController();
      const stepA = useStep('stepA');
      const afterStep = useStep('afterStep');
      const afterAbort = useStep('afterAbort');

      await Promise.all([
        sleep('5s'),
        (async () => {
          await stepA();
          await afterStep();
        })(),
        (async () => {
          await new Promise<void>((resolveListener) => {
            controller.signal.addEventListener('abort', resolveListener);
          });
          await afterAbort();
        })(),
      ]);
    });

    expectSuspendedWithPendingSteps(ctx, error, ['afterStep', 'afterAbort']);
  });
});

// ─── 5. idle reachability over the barrier registry ────────────────────────
//
// `hasParkedCommittedDelivery` decides whether an idle check may observe idle,
// and it is the only remaining caller of the recursive `resolvesOnItsOwn`
// walk. Two opposite answers are load-bearing, and neither is covered by the
// replay sections above, which exercise the walk only through whichever shape
// their fixture happens to build:
//
//  - A PARKED CHAIN must not be counted. An unclaimed buffered hook payload is
//    retired by the idle safety net in `registerDeliveryBarrier`, so counting
//    it would gate its own retirement — and that extends to the wait parked
//    behind it and the step gated on that wait. If any link were counted, idle
//    would be unreachable, no net could fire, and the chain would never
//    deliver: a deadlock, not a divergence.
//  - An ALL-ARMED BATCH must be counted (vercel/workflow#3183). Parallel step
//    results parked between their queue slots and their detached `resolve()`
//    are invisible to `pendingDeliveries`, and an idle check that observed idle
//    there would raise a `WorkflowSuspension` carrying none of the follow-up
//    work the batch was about to create.
//
// Asserted through `scheduleWhenIdle`, which is the coupling that matters, and
// which makes both cases unambiguous: nothing in these registries ever
// delivers, so the callback can only fire if the registry was excluded from
// the idle count AND the barriers' own nets then retired it.
//
// This replaces a timing guard that no longer measured anything. It timed
// `awaitEarlierDeliveries(ctx, 40, 'step')` against 40 alternating armed
// hook/wait barriers to catch an unmemoized exponential walk (4.3e8 recursive
// calls, 84s). That call site is gone: a step now tests `armed` directly, so
// the call is a flat loop. The surviving caller cannot reach an exponential
// shape at all — it returns at the first self-resolving entry, so it only
// advances past entries that short-circuit on their first false child
// (measured: 98 recursive calls unmemoized for the worst 40-barrier shape).
// Timing it would assert nothing; see the memo note on `resolvesOnItsOwn`.
describe('delivery-barrier idle reachability', () => {
  function emptyCtx(): WorkflowOrchestratorContext {
    return {
      pendingDeliveries: 0,
      promiseQueue: Promise.resolve(),
      pendingDeliveryBarriers: new Map(),
    } as unknown as WorkflowOrchestratorContext;
  }

  /** Whether `scheduleWhenIdle` observes idle within `rounds` timer ticks. */
  async function reachesIdle(
    ctx: WorkflowOrchestratorContext,
    rounds = 10
  ): Promise<boolean> {
    let idle = false;
    scheduleWhenIdle(ctx, () => {
      idle = true;
    });
    for (let round = 0; round < rounds && !idle; round++) {
      await ctx.promiseQueue;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return idle;
  }

  it('unwinds a step parked behind a wait parked on an unclaimed payload, in log order', async () => {
    const ctx = emptyCtx();
    const order: string[] = [];
    let payloadRetiredBeforeWait: boolean | undefined;

    // The shape `step-delivery-ordering.test.ts` replays, as a registry: an
    // unread hook's payload at index 0, a wait behind it, a step gated on that
    // wait. Only the payload lacks a delivery chain — nothing in the workflow
    // ever claims it, so the idle safety net is the only thing that can retire
    // it. The wait and the step get the unconditional chain their real call
    // sites attach at event-consumption time, as the INVARIANT on
    // `registerDeliveryBarrier` requires of any armed barrier.
    registerDeliveryBarrier(ctx, 0, 'hook', { armed: false });
    const wait = registerDeliveryBarrier(ctx, 1, 'wait');
    const step = registerDeliveryBarrier(ctx, 2, 'step');
    const chains = [
      awaitEarlierDeliveries(ctx, 1, 'wait').then(() => {
        order.push('wait');
        payloadRetiredBeforeWait = !ctx.pendingDeliveryBarriers?.has(0);
        wait.markDelivered();
      }),
      awaitEarlierDeliveries(ctx, 2, 'step').then(() => {
        order.push('step');
        step.markDelivered();
      }),
    ];
    expect(ctx.pendingDeliveryBarriers?.size).toBe(3);

    // Neither chain can run yet: the wait gates on the unclaimed payload, and
    // the step gates on the wait (it skips the payload directly, but the skip
    // is not transitive through the armed wait).
    await Promise.resolve();
    expect(order).toEqual([]);

    // Idle must stay reachable for the payload's net to fire at all. If any
    // link of the chain were counted against idle, this would hang.
    expect(await reachesIdle(ctx)).toBe(true);
    await Promise.all(chains);

    expect(payloadRetiredBeforeWait).toBe(true);
    expect(order).toEqual(['wait', 'step']);
    expect(ctx.pendingDeliveryBarriers?.size).toBe(0);
  });

  it('is blocked by an all-armed batch of step results', async () => {
    const ctx = emptyCtx();
    // Armed and undelivered is exactly the window #3183 is about: the batch's
    // queue slots have released `pendingDeliveries` and their detached
    // `resolve()` calls have not run yet.
    for (let index = 0; index < 3; index++) {
      registerDeliveryBarrier(ctx, index, 'step');
    }

    expect(await reachesIdle(ctx)).toBe(false);
    // The nets are idle-gated too, so nothing retires behind our back.
    expect(ctx.pendingDeliveryBarriers?.size).toBe(3);
  });
});

// ─── 6. suspension timing: idle must wait out parked deliveries ────────────
//
// Field shape from vercel/workflow#3183: a fire-and-forget `sleep()` (a
// watchdog — never awaited, never completing in-run) plus a parallel batch of
// step results. The sleep's subscriber reaches the end of the log on every
// replay and arms `scheduleWhenIdle`; the batch's step results release
// `pendingDeliveries` inside their serial queue slots but resolve from
// detached continuations, and every one after the first pays the
// step-behind-step deferral's macrotask yield. The armed idle check races
// exactly that yield.
//
// The assertions here are against the `WorkflowSuspension`'s OWN snapshot of
// the invocation queue (taken at raise time), not the live queue: the parked
// deliveries still resolve after a premature suspension, so the live queue
// eventually contains the follow-up step even when the suspension that the
// runtime acted on did not. A premature suspension surfaces as `[]` — zero
// invocations, nothing scheduled, a dormant run.
function expectSuspensionSnapshotSteps(error: unknown, expected: string[]) {
  if (!WorkflowSuspension.is(error)) {
    throw new Error(
      error === undefined
        ? 'expected the replay to suspend, but it completed'
        : error instanceof Error
          ? error.message
          : String(error),
      { cause: error }
    );
  }
  expect(
    (error as WorkflowSuspension).items.flatMap((item) =>
      item.type === 'step' ? [item.stepName] : []
    )
  ).toEqual(expected);
}

describe('suspension timing against parked step deliveries', () => {
  // Draw order: sleep -> ULIDS[0]; the three parallel steps -> 1..3; the
  // follow-up step (never run, so only allocated) -> 4.
  const RESUME_AT = new Date(FIXED_TIMESTAMP + 25 * 60_000);

  it('a parallel batch with a pending sleep suspends carrying the follow-up step', async () => {
    const ops: Promise<unknown>[] = [];
    const results = await Promise.all(
      ['a', 'b', 'c'].map((value) =>
        dehydrateStepReturnValue(value, 'wrun_test', undefined, ops)
      )
    );

    const events: Event[] = [
      event('evnt_0', 'wait_created', `wait_${ULIDS[0]}`, {
        resumeAt: RESUME_AT,
      }),
      event('evnt_1', 'step_created', `step_${ULIDS[1]}`, {
        stepName: 'parallelA',
      }),
      event('evnt_2', 'step_created', `step_${ULIDS[2]}`, {
        stepName: 'parallelB',
      }),
      event('evnt_3', 'step_created', `step_${ULIDS[3]}`, {
        stepName: 'parallelC',
      }),
      event('evnt_4', 'step_started', `step_${ULIDS[1]}`, {
        stepName: 'parallelA',
      }),
      event('evnt_5', 'step_started', `step_${ULIDS[2]}`, {
        stepName: 'parallelB',
      }),
      event('evnt_6', 'step_started', `step_${ULIDS[3]}`, {
        stepName: 'parallelC',
      }),
      event('evnt_7', 'step_completed', `step_${ULIDS[1]}`, {
        stepName: 'parallelA',
        result: results[0],
      }),
      event('evnt_8', 'step_completed', `step_${ULIDS[2]}`, {
        stepName: 'parallelB',
        result: results[1],
      }),
      event('evnt_9', 'step_completed', `step_${ULIDS[3]}`, {
        stepName: 'parallelC',
        result: results[2],
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);

    const error = await replay(ctx, async () => {
      // Watchdog: arms the idle check on every replay, completes on none.
      sleep('25m').catch(() => {});

      const parallelA = useStep('parallelA');
      const parallelB = useStep('parallelB');
      const parallelC = useStep('parallelC');
      const followUp = useStep('followUp');

      await Promise.all([parallelA(), parallelB(), parallelC()]);
      await followUp();
    });

    expectSuspensionSnapshotSteps(error, ['followUp']);
  });

  // Control from the same field data: 121 single-step rounds never stalled. A
  // lone step result defers behind nothing, resolves on microtasks ahead of
  // the idle check's macrotask, and needs no barrier awareness in the idle
  // check at all.
  it('control: a single-step round with a pending sleep is unaffected', async () => {
    const ops: Promise<unknown>[] = [];
    const result = await dehydrateStepReturnValue(
      'a',
      'wrun_test',
      undefined,
      ops
    );

    const events: Event[] = [
      event('evnt_0', 'wait_created', `wait_${ULIDS[0]}`, {
        resumeAt: RESUME_AT,
      }),
      event('evnt_1', 'step_created', `step_${ULIDS[1]}`, {
        stepName: 'only',
      }),
      event('evnt_2', 'step_started', `step_${ULIDS[1]}`, {
        stepName: 'only',
      }),
      event('evnt_3', 'step_completed', `step_${ULIDS[1]}`, {
        stepName: 'only',
        result,
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);

    const error = await replay(ctx, async () => {
      sleep('25m').catch(() => {});

      const only = useStep('only');
      const followUp = useStep('followUp');

      await only();
      await followUp();
    });

    expectSuspensionSnapshotSteps(error, ['followUp']);
  });
});

// ─── step result above a wait parked behind an unclaimed payload ────────────
//
// The log-order-draws turnstile (`quiesceEarlierCascades`) refuses to resolve
// a delivery while a LOWER-index ARMED barrier is still registered. An armed
// wait can itself be parked behind an unclaimed buffered hook payload — a
// chain only the idle-gated safety net can move (lowest-first retirement).
// This test pins the termination argument for that shape: the spinning step
// delivery must not count as a parked committed delivery (`resolvesOnItsOwn`
// excludes it — it gates on the parked wait), so `canRetireAbandonedBarriers`
// stays reachable, the net retires the payload, the wait delivers, and the
// turnstile opens. A regression that makes the turnstile wait on parked
// chains directly, or counts the spinner as self-resolving, deadlocks this
// replay instead of suspending it.
describe('log-order draws turnstile above a parked chain', () => {
  const scenario = async () => {
    const resumeAt = new Date(FIXED_TIMESTAMP + 5_000);
    const ops: Promise<unknown>[] = [];
    const [payload, stepAResult] = await Promise.all([
      dehydrateStepReturnValue({ poke: 1 }, 'wrun_test', undefined, ops),
      dehydrateStepReturnValue('a', 'wrun_test', undefined, ops),
    ]);

    const events: Event[] = [
      event('evnt_0', 'hook_created', `hook_${ULIDS[0]}`, {
        token: 'parked-token',
        isWebhook: false,
      }),
      event('evnt_1', 'wait_created', `wait_${ULIDS[1]}`, { resumeAt }),
      event('evnt_2', 'step_created', `step_${ULIDS[2]}`, {
        stepName: 'stepA',
      }),
      event('evnt_3', 'step_started', `step_${ULIDS[2]}`, {
        stepName: 'stepA',
      }),
      event('evnt_4', 'hook_received', `hook_${ULIDS[0]}`, { payload }),
      event('evnt_5', 'wait_completed', `wait_${ULIDS[1]}`, { resumeAt }),
      event('evnt_6', 'step_completed', `step_${ULIDS[2]}`, {
        stepName: 'stepA',
        result: stepAResult,
      }),
      event('evnt_7', 'step_created', `step_${ULIDS[3]}`, {
        stepName: 'afterBoth',
      }),
    ];

    const ctx = setupWorkflowContext(events);
    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);
    const createHook = createCreateHook(ctx);

    const error = await replay(ctx, async () => {
      const stepA = useStep('stepA');
      const afterBoth = useStep('afterBoth');
      // Fire-and-forget hook: its payload (evnt_4) is consumed but never
      // claimed, so its barrier stays unarmed and parks the wait behind it.
      createHook({ token: 'parked-token' });
      await Promise.all([sleep('5s'), stepA()]);
      await afterBoth();
    });

    expectSuspendedWithPendingSteps(ctx, error, ['afterBoth']);
  };

  it('terminates and suspends with log-order draws on', async () => {
    // Pin the flag rather than inherit the ambient environment: a suite-wide
    // WORKFLOW_LOG_ORDER_DRAWS=0 sweep would otherwise silently run the off
    // path twice and this test would prove nothing about the turnstile.
    vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', '1');
    try {
      await scenario();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('terminates and suspends with log-order draws off', async () => {
    vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', '0');
    try {
      await scenario();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
