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
 *  3. ABORT deliveries. `_setAborted` fires the signal's listeners, and a
 *     listener may invoke a step and draw a ULID, so an abort is as
 *     branch-deciding as any other delivery — but it resolved straight off its
 *     `promiseQueue` slot and registered no barrier.
 *
 * Cases 1-4 assert the same thing: the replay allocates its follow-up step
 * ULIDs in the order the committed log recorded. A regression surfaces as the
 * production `ReplayDivergenceError`.
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
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(`Unconsumed event: ${event.eventType}`)
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateHookToken: (correlationId: string) => `token_${correlationId}`,
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

// ─── 3. abort deliveries ───────────────────────────────────────────────────
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

// ─── 4. registry scan cost ─────────────────────────────────────────────────
//
// `resolvesOnItsOwn` walks the registry recursively: an armed hook re-checks
// every earlier wait and step, an armed wait every earlier hook and step, and
// so on. Unmemoized that is T(n) = Σ T(j) — exponential — and the registry is
// not small by construction: `EventsConsumer` drains consecutively consumable
// events synchronously while barriers only retire on microtask-driven
// deliveries, so a fan-out of `Promise.race([hook, sleep(watchdog)])` branches
// accumulates one barrier per branch per kind (measured: 49 live barriers for
// 24 branches).
//
// The scan runs synchronously, before `awaitEarlierDeliveries` first awaits,
// so timing the call alone measures it. Unmemoized, 40 alternating armed
// hook/wait barriers is ~10^8 recursive calls — minutes. Memoized it is
// linear. The bound is deliberately loose; this is an order-of-magnitude
// guard, not a benchmark.
describe('delivery-barrier registry scan cost', () => {
  it('stays linear in registry size for a step delivery', () => {
    const ctx = {
      pendingDeliveries: 0,
      promiseQueue: Promise.resolve(),
      pendingDeliveryBarriers: new Map(),
    } as unknown as WorkflowOrchestratorContext;

    const BARRIERS = 40;
    for (let index = 0; index < BARRIERS; index++) {
      registerDeliveryBarrier(ctx, index, index % 2 ? 'hook' : 'wait');
    }
    expect(ctx.pendingDeliveryBarriers?.size).toBe(BARRIERS);

    const startedAt = performance.now();
    // The floating promise never settles (nothing delivers these barriers);
    // only the synchronous scan inside the call is under test.
    void awaitEarlierDeliveries(ctx, BARRIERS, 'step');
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

// ─── 5. suspension timing: idle must wait out parked deliveries ────────────
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
    (error as WorkflowSuspension).steps.flatMap((item) =>
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
