import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

/**
 * Production incident: two o2flow runs on `@workflow/core@5.0.0-beta.36`
 * (`wrun_41KYJENABV0GSF5YTE9EETV5DD` and `wrun_41KYJEE01S0GPC9RWT5MEKVCX8`)
 * failed permanently with
 *
 *   Replay divergence: step event step_created for step_X belongs to
 *   "countFanoutStep", but the current step consumer is
 *   "releaseGlobalLaunchSlot"
 *
 * repeated at the SAME eventId across three divergence-recovery replays, and
 * then escalated to a terminal `CorruptedEventLogError`.
 *
 * Mechanism reproduced here:
 *
 * - Each `useStep(...)` invocation draws the next deterministic ULID as its
 *   correlation id (`step.ts`), so WHICH workflow branch resumes first decides
 *   which correlation id each step call gets. Replay matches events to
 *   consumers by exact correlation id and rejects a `step_created` whose
 *   recorded `stepName` differs from the consumer's (`step.ts`, the
 *   `eventStepName !== stepName` divergence check).
 * - The runtime has a delivery-barrier system that pins branch-deciding
 *   delivery order to event-log position (`pendingDeliveryBarriers` in
 *   `private.ts`), but it only covers the kinds `'hook'` and `'wait'`.
 *   **Step results are not in it.**
 * - `wait_completed` resolves through a detached chain with a fixed, small
 *   microtask-hop count (`workflow/sleep.ts`). A `step_completed` instead
 *   resolves inside a serial `ctx.promiseQueue` slot that first hydrates the
 *   payload via `ReplayPayloadCache.getStepResult(...)`. That hop count is not
 *   fixed: the first hydration pays async decrypt/deserialize, while a later
 *   replay sharing the same `ReplayPayloadCache` hits the
 *   `primitiveStepResults` memo for small primitive results and resolves in
 *   one or two hops.
 *
 * So when a `step_completed` sits adjacent in the log to a `wait_completed`
 * (or `hook_received`) and both consumers are live, the FIRST replay of a
 * queue delivery (cold cache) delivers the wait first — the ordering the live
 * invocation recorded into the log — while every LATER replay in that same
 * delivery (warm cache) delivers the step result first. The two branches then
 * allocate each other's ULIDs and diverge, forever, at the same event.
 *
 * Production log shape for run 1, which the synthetic log below mirrors:
 *
 *   …, step_completed(finalizeTaskSandbox), wait_completed, wait_completed,
 *   step_completed(finalizeTaskSandbox), step_created(countFanoutStep),
 *   step_created(releaseGlobalLaunchSlot), …
 *
 * This is entirely core replay machinery — no World implementation is
 * involved. Worlds only supply event I/O, so the bug is not specific to the
 * Vercel world.
 *
 * These tests assert the CORRECT behavior: both replays must agree with the
 * committed log and suspend. On `main` the second replay instead throws
 * `ReplayDivergenceError`, which is the reproduction. The companion fix on
 * branch `pgp/fix-step-delivery-ordering` adds `'step'` to the
 * delivery-barrier system and makes these pass.
 */

/**
 * Harness copied from `hook-sleep-interaction.test.ts`, with one addition: a
 * `ReplayPayloadCache` can be passed in, so two sequential replays can share
 * one cache exactly like the replay loop inside a single production queue
 * delivery does (see the `ReplayPayloadCache` class docstring).
 */
function setupWorkflowContext(
  events: Event[],
  replayPayloadCache: ReplayPayloadCache = new ReplayPayloadCache(undefined)
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
    replayPayloadCache,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}. This indicates a corrupted or invalid event log.`
          )
        );
      },
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
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

// Deterministic correlation IDs from the ULID generator with seed 'test'
const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
  '01K11TFZ62YS0YYFDQ3E8B9YCY',
];

async function runWithDiscontinuation(
  ctx: WorkflowOrchestratorContext,
  workflowFn: () => Promise<any>
): Promise<{ result?: any; error?: any }> {
  const workflowDiscontinuation = withResolvers<void>();
  ctx.onWorkflowError = workflowDiscontinuation.reject;

  let result: any;
  let error: any;
  try {
    result = await Promise.race([
      workflowFn(),
      workflowDiscontinuation.promise,
    ]);
  } catch (err) {
    error = err;
  }
  return { result, error };
}

/**
 * Models the cost of first-touch payload hydration (decrypt + deserialize).
 * Production shares prepared bytes and memoized primitive results across the
 * replays of one queue delivery, so the second replay of a small primitive
 * step result never reaches this spy — which is exactly the hop-count
 * asymmetry under test.
 */
function delayHydration() {
  const hydrateSpy = vi.fn();
  return {
    hydrateSpy,
    install: async () => {
      const serialization = await import('./serialization.js');
      const originalHydrate = serialization.hydrateStepReturnValue;
      return vi
        .spyOn(serialization, 'hydrateStepReturnValue')
        .mockImplementation(async (...args) => {
          hydrateSpy();
          await new Promise((r) => setTimeout(r, 10));
          return originalHydrate(...args);
        });
    },
  };
}

describe('step result delivery ordering across replays', () => {
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  describe('step_completed adjacent to wait_completed', () => {
    // The wait's `resumeAt` is re-read from the `wait_created` event during
    // replay (see `workflow/sleep.ts`), so any fixed date works here as long
    // as `wait_created` and `wait_completed` agree.
    const resumeAt = new Date('2026-07-27T12:00:05.000Z');

    async function buildEventLog(): Promise<Event[]> {
      const ops: Promise<any>[] = [];
      // A short string result is a memoizable primitive, so the SECOND replay
      // sharing the cache resolves it from `primitiveStepResults` without
      // touching hydration at all.
      const stepAResult = await dehydrateStepReturnValue(
        'ok',
        'wrun_test',
        undefined,
        ops
      );

      return [
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[0]}`,
          eventData: { stepName: 'stepA' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[0]}`,
          eventData: { stepName: 'stepA' },
          createdAt: new Date(),
        },
        // The live invocation delivered the wait BEFORE the step result, so
        // the wait branch resumed first and drew the next ULID. Everything
        // after this point in the log encodes that ordering.
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'wait_completed',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[0]}`,
          eventData: { stepName: 'stepA', result: stepAResult },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'afterSleep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'afterStep' },
          createdAt: new Date(),
        },
      ];
    }

    // ULID draw order in this body: `stepA()` takes CORR_IDS[0], `sleep()`
    // takes CORR_IDS[1], and then whichever branch is resumed FIRST takes
    // CORR_IDS[2] while the other takes CORR_IDS[3].
    function workflowBody(ctx: WorkflowOrchestratorContext) {
      const useStep = createUseStep(ctx);
      const sleep = createSleep(ctx);

      return async () => {
        const stepA = useStep('stepA');
        const afterStep = useStep('afterStep');
        const afterSleep = useStep('afterSleep');

        const branchStep = (async () => {
          await stepA();
          await afterStep();
        })();
        const branchSleep = (async () => {
          await sleep(resumeAt);
          await afterSleep();
        })();

        await Promise.all([branchStep, branchSleep]);
      };
    }

    function pendingStepNames(ctx: WorkflowOrchestratorContext): string[] {
      return [...ctx.invocationsQueue.values()]
        .filter((item) => item.type === 'step')
        .map((item) => (item.type === 'step' ? item.stepName : ''));
    }

    it('delivers the wait before the step result on the first replay, matching the log', async () => {
      const hydration = delayHydration();
      spy = await hydration.install();
      const events = await buildEventLog();

      const ctx = setupWorkflowContext(events);
      const { error } = await runWithDiscontinuation(ctx, workflowBody(ctx));

      expect(error).toBeDefined();
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }

      // The log's ordering was reproduced: the sleep branch resumed first and
      // drew CORR_IDS[2] for `afterSleep`, so both `step_created` events at
      // the tail matched their consumers and the run suspends with both
      // follow-up steps pending.
      expect(pendingStepNames(ctx).sort()).toEqual(['afterSleep', 'afterStep']);
      expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
    });

    it.fails('delivers the wait before the step result on a later replay sharing the payload cache', async () => {
      const hydration = delayHydration();
      spy = await hydration.install();
      const events = await buildEventLog();

      // One cache for both replays: production shares a single
      // `ReplayPayloadCache` across every replay of one queue delivery.
      const sharedCache = new ReplayPayloadCache(undefined);

      const firstCtx = setupWorkflowContext(events, sharedCache);
      const first = await runWithDiscontinuation(
        firstCtx,
        workflowBody(firstCtx)
      );
      if (!WorkflowSuspension.is(first.error)) {
        throw first.error ?? new Error('expected the first replay to suspend');
      }
      expect(hydration.hydrateSpy).toHaveBeenCalled();

      // Second replay, fresh VM/context, same event log, same cache. The step
      // result is now memoized as a primitive, so it resolves in a couple of
      // microtask hops instead of paying hydration — while the wait's hop
      // count is unchanged.
      const secondCtx = setupWorkflowContext(events, sharedCache);
      const { error } = await runWithDiscontinuation(
        secondCtx,
        workflowBody(secondCtx)
      );

      expect(error).toBeDefined();
      // FAILS on `main`: the step result now wins, `afterStep` draws
      // CORR_IDS[2], and replay diverges at evnt_5 with the production error
      // shape ("... belongs to \"afterSleep\", but the current step consumer
      // is \"afterStep\"").
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }
      expect(pendingStepNames(secondCtx).sort()).toEqual([
        'afterSleep',
        'afterStep',
      ]);
      expect(secondCtx.eventsConsumer.eventIndex).toBe(events.length);
    });
  });

  describe('step_completed adjacent to hook_received', () => {
    async function buildEventLog(): Promise<Event[]> {
      const ops: Promise<any>[] = [];
      const [hookPayload, stepAResult] = await Promise.all([
        dehydrateStepReturnValue({ kind: 'ping' }, 'wrun_test', undefined, ops),
        dehydrateStepReturnValue('ok', 'wrun_test', undefined, ops),
      ]);

      return [
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { token: 'test-token', isWebhook: false },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'stepA' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'stepA' },
          createdAt: new Date(),
        },
        // The live invocation delivered the hook payload BEFORE the step
        // result, so the hook branch resumed first and drew the next ULID.
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { token: 'test-token', payload: hookPayload },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'stepA', result: stepAResult },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'afterHook' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'afterStep' },
          createdAt: new Date(),
        },
      ];
    }

    /**
     * ULID draw order: `createHook()` takes CORR_IDS[0], `stepA()` takes
     * CORR_IDS[1], then the branch resumed FIRST takes CORR_IDS[2].
     *
     * Two ways of consuming the hook, which differ in whether the payload is
     * buffered when `hook_received` is consumed:
     *
     * - `for-await` (the idiomatic pattern, and what reproduces): the async
     *   iterator's body starts on the microtask queue, so it has not
     *   subscribed yet when the consumer drains the log on `process.nextTick`.
     *   The payload is buffered and delivered later through `claim()`
     *   (`workflow/hook.ts`), whose chain adds hops on top of the hydration
     *   slot.
     * - `await hook` (control): subscribes synchronously, so `hook_received`
     *   hydrates and resolves through the `promises.length > 0` branch. That
     *   slot is queued on `ctx.promiseQueue` ahead of the later
     *   `step_completed` slot, so the serial queue alone happens to preserve
     *   log order here.
     */
    function workflowBody(
      ctx: WorkflowOrchestratorContext,
      consume: 'for-await' | 'direct-await'
    ) {
      const useStep = createUseStep(ctx);
      const createHook = createCreateHook(ctx);

      return async () => {
        const stepA = useStep('stepA');
        const afterStep = useStep('afterStep');
        const afterHook = useStep('afterHook');
        const hook = createHook<{ kind: string }>({ token: 'test-token' });

        const branchStep = (async () => {
          await stepA();
          await afterStep();
        })();
        const branchHook = (async () => {
          if (consume === 'direct-await') {
            await hook;
            await afterHook();
            return;
          }
          for await (const payload of hook) {
            void payload;
            await afterHook();
            break;
          }
        })();

        await Promise.all([branchStep, branchHook]);
      };
    }

    function pendingStepNames(ctx: WorkflowOrchestratorContext): string[] {
      return [...ctx.invocationsQueue.values()]
        .filter((item) => item.type === 'step')
        .map((item) => (item.type === 'step' ? item.stepName : ''));
    }

    it('delivers the hook payload before the step result on the first replay, matching the log', async () => {
      const hydration = delayHydration();
      spy = await hydration.install();
      const events = await buildEventLog();

      const ctx = setupWorkflowContext(events);
      const { error } = await runWithDiscontinuation(
        ctx,
        workflowBody(ctx, 'for-await')
      );

      expect(error).toBeDefined();
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }
      expect(pendingStepNames(ctx).sort()).toEqual(['afterHook', 'afterStep']);
      expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
    });

    it.fails('delivers the hook payload before the step result on a later replay sharing the payload cache', async () => {
      const hydration = delayHydration();
      spy = await hydration.install();
      const events = await buildEventLog();
      const sharedCache = new ReplayPayloadCache(undefined);

      const firstCtx = setupWorkflowContext(events, sharedCache);
      const first = await runWithDiscontinuation(
        firstCtx,
        workflowBody(firstCtx, 'for-await')
      );
      if (!WorkflowSuspension.is(first.error)) {
        throw first.error ?? new Error('expected the first replay to suspend');
      }
      expect(hydration.hydrateSpy).toHaveBeenCalled();

      // Hook payloads have no primitive memo, so the buffered payload still
      // re-hydrates on the second replay while the small primitive step result
      // is served straight from `primitiveStepResults`.
      const secondCtx = setupWorkflowContext(events, sharedCache);
      const { error } = await runWithDiscontinuation(
        secondCtx,
        workflowBody(secondCtx, 'for-await')
      );

      expect(error).toBeDefined();
      // FAILS on `main`: the step result overtakes the buffered hook payload,
      // `afterStep` draws CORR_IDS[2], and replay diverges at evnt_5 with the
      // production error shape.
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }
      expect(pendingStepNames(secondCtx).sort()).toEqual([
        'afterHook',
        'afterStep',
      ]);
      expect(secondCtx.eventsConsumer.eventIndex).toBe(events.length);
    });

    // Control: subscribing synchronously with `await hook` keeps log order on
    // both replays today, because the hook's hydration slot is queued on the
    // serial `promiseQueue` ahead of the `step_completed` slot. The fix must
    // not regress this.
    it('keeps log order across replays when the hook is awaited directly', async () => {
      const hydration = delayHydration();
      spy = await hydration.install();
      const events = await buildEventLog();
      const sharedCache = new ReplayPayloadCache(undefined);

      for (const replay of [1, 2]) {
        const ctx = setupWorkflowContext(events, sharedCache);
        const { error } = await runWithDiscontinuation(
          ctx,
          workflowBody(ctx, 'direct-await')
        );
        if (!WorkflowSuspension.is(error)) {
          throw error ?? new Error(`expected replay ${replay} to suspend`);
        }
        expect(pendingStepNames(ctx).sort()).toEqual([
          'afterHook',
          'afterStep',
        ]);
        expect(ctx.eventsConsumer.eventIndex).toBe(events.length);
      }
    });
  });
});
