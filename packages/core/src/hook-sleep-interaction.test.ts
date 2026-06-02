import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

/**
 * These tests isolate a regression from #1246 where queueing
 * WorkflowSuspension through promiseQueue causes premature termination
 * when a hook has buffered payloads and another entity (sleep or
 * incomplete step) hasn't completed.
 *
 * Each test runs in two modes:
 * - **sync**: no deserialization delay (encryption disabled)
 * - **async**: 10ms deserialization delay (simulates encryption/decryption)
 *
 * The fix uses two-phase deferral: `promiseQueue.then(() => setTimeout(0))`
 * so suspensions wait for both async deserialization AND microtask deliveries.
 */

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  // Forward onUnconsumedEvent through ctx.onWorkflowError so tests that wire
  // onWorkflowError to a discontinuation promise (see runWithDiscontinuation)
  // actually observe false-positive unconsumed-event detections instead of
  // silently dropping them.
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
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
  '01K11TFZ62YS0YYFDQ3E8B9YCZ',
  '01K11TFZ62YS0YYFDQ3E8B9YD0',
];

// ─── Helpers ───────────────────────────────────────────

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
 * Defines the full test suite for a given deserialization mode.
 * In 'async' mode, hydrateStepReturnValue is mocked with a 10ms delay
 * to simulate encryption/decryption.
 */
function defineTests(mode: 'sync' | 'async') {
  const label = mode === 'async' ? '(async deserialization)' : '(sync)';

  let hydrateSpy: ReturnType<typeof vi.spyOn> | undefined;

  async function setupHydrateMock() {
    if (mode === 'async') {
      const serialization = await import('./serialization.js');
      const originalHydrate = serialization.hydrateStepReturnValue;
      hydrateSpy = vi
        .spyOn(serialization, 'hydrateStepReturnValue')
        .mockImplementation(async (...args) => {
          await new Promise((r) => setTimeout(r, 10));
          return originalHydrate(...args);
        });
    }
  }

  afterEach(() => {
    hydrateSpy?.mockRestore();
    hydrateSpy = undefined;
  });

  // ─── Bug reproductions: hook + pending entity ──────────

  describe(`hook + sleep ${label}`, () => {
    it('should deliver all hook payloads before sleep suspension terminates the workflow', async () => {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload1, payload2, payload3] = await Promise.all([
        dehydrateStepReturnValue(
          { type: 'subscribe', id: 1 },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(
          { type: 'subscribe', id: 2 },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(
          { type: 'stopped' },
          'wrun_test',
          undefined,
          ops
        ),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            isWebhook: false,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload1,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload2,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload3,
          },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook({ token: 'test-token' });
        void sleep('1d');

        const myStep = useStep('myStep');
        const received: any[] = [];

        for await (const message of hook) {
          received.push(message);
          if ((message as any).type === 'stopped') {
            await myStep();
            return { payloads: received };
          }
        }
      });

      expect(error).toBeDefined();
      expect(WorkflowSuspension.is(error)).toBe(true);

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'myStep'
      );
    });

    it('should not prematurely suspend when hook has queued payloads and sleep is pending', async () => {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload1, payload2] = await Promise.all([
        dehydrateStepReturnValue('first', 'wrun_test', undefined, ops),
        dehydrateStepReturnValue('second', 'wrun_test', undefined, ops),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            isWebhook: false,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload1,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload2,
          },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook({ token: 'test-token' });
        void sleep('1d');

        const val1 = await hook;
        const val2 = await hook;
        return [val1, val2];
      });

      expect(error).toBeUndefined();
      expect(result).toEqual(['first', 'second']);
    });

    it.fails('should let a queued hook payload win when a reused wait completes after the step that installs the race', async () => {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload, setupResult] = await Promise.all([
        dehydrateStepReturnValue(
          { value: 'hook-wins' },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(undefined, 'wrun_test', undefined, ops),
      ]);
      const resumeAt = new Date('2026-05-20T22:16:57.197Z');

      // This is an ordered durable history where the hook branch already won.
      // setupWorkflowContext exercises core replay without a World backend.
      const ctx = setupWorkflowContext([
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
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { token: 'test-token', payload },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'setupStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'setupStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'setupStep', result: setupResult },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'wait_completed',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_7',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'drainStep' },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook<{ value: string }>({ token: 'test-token' });
        const iterator = hook[Symbol.asyncIterator]();
        const pendingSleep = sleep(resumeAt);
        const setupStep = useStep('setupStep');
        const drainStep = useStep('drainStep');
        const syncNextStep = useStep('syncNextStep');

        await setupStep();

        const result = await Promise.race([
          iterator.next().then((value) => ({ kind: 'hook' as const, value })),
          pendingSleep.then(() => ({ kind: 'sleep' as const })),
        ]);

        if (result.kind === 'hook') {
          await drainStep();
          return result.value.value;
        }

        await syncNextStep();
        return 'sleep';
      });

      expect(error).toBeDefined();
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'drainStep'
      );
    });

    async function expectRawRaceToChooseQueuedHook(
      hookWaitBeforeSetup: boolean
    ) {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload, setupResult] = await Promise.all([
        dehydrateStepReturnValue(
          { value: 'hook-wins' },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(undefined, 'wrun_test', undefined, ops),
      ]);
      const resumeAt = new Date('2026-05-20T22:16:57.197Z');

      // This is the same ordered durable history as the mapped-race test.
      const ctx = setupWorkflowContext([
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
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { token: 'test-token', payload },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'setupStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'setupStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'setupStep', result: setupResult },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'wait_completed',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_7',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'drainStep' },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook<{ value: string }>({ token: 'test-token' });
        const iterator = hook[Symbol.asyncIterator]();
        const pendingHook = hookWaitBeforeSetup ? iterator.next() : undefined;
        const pendingSleep = sleep(resumeAt);
        const setupStep = useStep('setupStep');
        const drainStep = useStep('drainStep');
        const syncNextStep = useStep('syncNextStep');

        await setupStep();

        const result = await Promise.race([
          pendingHook ?? iterator.next(),
          pendingSleep,
        ]);

        if (result !== undefined) {
          await drainStep();
          return result.value.value;
        }

        await syncNextStep();
        return 'sleep';
      });

      expect(error).toBeDefined();
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'drainStep'
      );
    }

    it.fails('should let a queued hook payload win without mapping the race promises', async () => {
      await expectRawRaceToChooseQueuedHook(false);
    });

    it('should let a queued hook payload win when iterator.next is pending before the setup step completes', async () => {
      await expectRawRaceToChooseQueuedHook(true);
    });

    async function replayEarlyWaiterAcrossDrain(options: {
      winner: 'hook' | 'sleep';
    }) {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [
        payload0,
        payload1,
        progress0Result,
        drain0Result,
        progress1Result,
      ] = await Promise.all([
        dehydrateStepReturnValue(
          { value: 'first-wake' },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(
          { value: 'second-wake' },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(undefined, 'wrun_test', undefined, ops),
        dehydrateStepReturnValue(undefined, 'wrun_test', undefined, ops),
        dehydrateStepReturnValue(undefined, 'wrun_test', undefined, ops),
      ]);
      const resumeAt = new Date('2026-05-29T23:14:03.369Z');

      const secondHookEvent: Event = {
        eventId: 'evnt_8',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: `hook_${CORR_IDS[0]}`,
        eventData: { token: 'test-token', payload: payload1 },
        createdAt: new Date(),
      };
      const waitCompletedEvent: Event = {
        eventId: 'evnt_10',
        runId: 'wrun_test',
        eventType: 'wait_completed',
        correlationId: `wait_${CORR_IDS[2]}`,
        eventData: { resumeAt },
        createdAt: new Date(),
      };
      const decidingEvents =
        options.winner === 'hook'
          ? [secondHookEvent, waitCompletedEvent]
          : [waitCompletedEvent, secondHookEvent];
      const finalStepName =
        options.winner === 'hook' ? 'drainStep' : 'progressStep';

      // This models the deployed loop after the user moved iterator.next()
      // before the progress step. The second payload and the reused wait can
      // become ready while the first hook-winning drain is still running.
      const ctx = setupWorkflowContext([
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
          eventData: { stepName: 'progressStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'progressStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'progressStep', result: progress0Result },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[2]}`,
          eventData: { resumeAt },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { token: 'test-token', payload: payload0 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'drainStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_7',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'drainStep' },
          createdAt: new Date(),
        },
        ...decidingEvents,
        {
          eventId: 'evnt_9',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'drainStep', result: drain0Result },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_11',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[4]}`,
          eventData: { stepName: 'progressStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_12',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[4]}`,
          eventData: { stepName: 'progressStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_13',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[4]}`,
          eventData: { stepName: 'progressStep', result: progress1Result },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_14',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[5]}`,
          eventData: { stepName: finalStepName },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook<{ value: string }>({ token: 'test-token' });
        const iterator = hook[Symbol.asyncIterator]();
        const progressStep = useStep('progressStep');
        const drainStep = useStep('drainStep');
        let pendingSleep: Promise<void> | undefined;

        for (let index = 0; index < 2; index++) {
          const pendingRead = iterator.next();
          await progressStep();
          pendingSleep ??= sleep(resumeAt);

          const result = await Promise.race([
            pendingRead.then((value) => ({ kind: 'hook' as const, value })),
            pendingSleep.then(() => ({ kind: 'sleep' as const })),
          ]);

          if (result.kind === 'hook') {
            await drainStep();
            continue;
          }

          pendingSleep = undefined;
          if (index === 1) {
            await progressStep();
          }
        }
      });

      return { ctx, error };
    }

    it('should preserve the early waiter with a reused sleep when the buffered hook wins', async () => {
      const { ctx, error } = await replayEarlyWaiterAcrossDrain({
        winner: 'hook',
      });

      expect(error).toBeDefined();
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'drainStep'
      );
    });

    it.fails('should preserve the early waiter with a reused sleep when wait completion wins', async () => {
      const { ctx, error } = await replayEarlyWaiterAcrossDrain({
        winner: 'sleep',
      });

      expect(error).toBeDefined();
      if (!WorkflowSuspension.is(error)) {
        throw error;
      }

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'progressStep'
      );
    });
  });

  describe(`hook + incomplete step ${label}`, () => {
    it('should deliver all hook payloads when a concurrent step has not completed', async () => {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload1, payload2] = await Promise.all([
        dehydrateStepReturnValue('msg1', 'wrun_test', undefined, ops),
        dehydrateStepReturnValue('msg2', 'wrun_test', undefined, ops),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            isWebhook: false,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'incompleteStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: {
            stepName: 'incompleteStep',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload1,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload2,
          },
          createdAt: new Date(),
        },
      ]);

      const useStep = createUseStep(ctx);
      const createHook = createCreateHook(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        const incompleteStep = useStep('incompleteStep');
        const hook = createHook({ token: 'test-token' });

        void incompleteStep().then(() => {});

        const val1 = await hook;
        const val2 = await hook;
        return [val1, val2];
      });

      expect(error).toBeUndefined();
      expect(result).toEqual(['msg1', 'msg2']);
    });
  });

  // ─── Control group: patterns that should work ──────────

  describe(`sleep + sequential steps ${label}`, () => {
    it('should resolve all steps even when sleep has not completed', async () => {
      await setupHydrateMock();
      const [resultA, resultB] = await Promise.all([
        dehydrateStepReturnValue(10, 'wrun_test', undefined),
        dehydrateStepReturnValue(20, 'wrun_test', undefined),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[0]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
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
          eventData: {
            stepName: 'stepA',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: {
            stepName: 'stepA',
            result: resultA,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'stepB' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: {
            stepName: 'stepB',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: {
            stepName: 'stepB',
            result: resultB,
          },
          createdAt: new Date(),
        },
      ]);

      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        void sleep('1d').then(() => {});
        const stepA = useStep('stepA');
        const stepB = useStep('stepB');

        const a = await stepA();
        const b = await stepB();
        return [a, b];
      });

      expect(error).toBeUndefined();
      expect(result).toEqual([10, 20]);
    });

    it('should correctly suspend with second step in queue when only first step completed', async () => {
      await setupHydrateMock();
      const resultA = await dehydrateStepReturnValue(
        10,
        'wrun_test',
        undefined
      );

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[0]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
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
          eventData: {
            stepName: 'stepA',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: {
            stepName: 'stepA',
            result: resultA,
          },
          createdAt: new Date(),
        },
      ]);

      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        void sleep('1d').then(() => {});
        const stepA = useStep('stepA');
        const stepB = useStep('stepB');

        const a = await stepA();
        const b = await stepB();
        return [a, b];
      });

      expect(error).toBeDefined();
      expect(WorkflowSuspension.is(error)).toBe(true);

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'stepB'
      );
    });
  });

  describe(`incomplete step + sequential steps ${label}`, () => {
    it('should resolve subsequent steps when a fire-and-forget step has not completed', async () => {
      await setupHydrateMock();
      const [resultB, resultC] = await Promise.all([
        dehydrateStepReturnValue('B', 'wrun_test', undefined),
        dehydrateStepReturnValue('C', 'wrun_test', undefined),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[0]}`,
          eventData: { stepName: 'incompleteStep' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[0]}`,
          eventData: {
            stepName: 'incompleteStep',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { stepName: 'stepB' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: {
            stepName: 'stepB',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: {
            stepName: 'stepB',
            result: resultB,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'stepC' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: {
            stepName: 'stepC',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_7',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: {
            stepName: 'stepC',
            result: resultC,
          },
          createdAt: new Date(),
        },
      ]);

      const useStep = createUseStep(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        const incompleteStep = useStep('incompleteStep');
        const stepB = useStep('stepB');
        const stepC = useStep('stepC');

        void incompleteStep().then(() => {});
        const b = await stepB();
        const c = await stepC();
        return [b, c];
      });

      expect(error).toBeUndefined();
      expect(result).toEqual(['B', 'C']);
    });
  });

  describe(`hook + sleep with step per payload ${label}`, () => {
    it('should not trigger unconsumed event error when for-await loop calls a step per hook payload', async () => {
      // Reproduces CI failure: hookWithSleepWorkflow event log had alternating
      // hook_received + step lifecycle events. During replay, the EventsConsumer
      // advances past the second step_created before the for-await loop has
      // called processPayload (and registered the step consumer). The deferred
      // unconsumed check must wait for the new async work (hook payload
      // deserialization) before declaring the event orphaned.
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload1, payload2, stepResult1, stepResult2] = await Promise.all([
        dehydrateStepReturnValue(
          { type: 'subscribe', id: 1 },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(
          { type: 'done', done: true },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(
          { processed: true, type: 'subscribe', id: 1 },
          'wrun_test',
          undefined,
          ops
        ),
        dehydrateStepReturnValue(
          { processed: true, type: 'done' },
          'wrun_test',
          undefined,
          ops
        ),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            isWebhook: false,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
          createdAt: new Date(),
        },
        // First hook payload → step lifecycle
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload1,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { stepName: 'processPayload', input: payload1 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: {
            stepName: 'processPayload',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_5',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: {
            stepName: 'processPayload',
            result: stepResult1,
          },
          createdAt: new Date(),
        },
        // Second hook payload → step lifecycle
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload2,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_7',
          runId: 'wrun_test',
          eventType: 'step_created',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: { stepName: 'processPayload', input: payload2 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_8',
          runId: 'wrun_test',
          eventType: 'step_started',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: {
            stepName: 'processPayload',
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_9',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[3]}`,
          eventData: {
            stepName: 'processPayload',
            result: stepResult2,
          },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook({ token: 'test-token' });
        void sleep('1d');

        const processPayload = useStep<[any], any>('processPayload');
        const results: any[] = [];

        for await (const payload of hook) {
          const processed = await processPayload(payload);
          results.push(processed);
          if ((payload as any).done) break;
        }

        return results;
      });

      expect(error).toBeUndefined();
      expect(result).toEqual([
        { processed: true, type: 'subscribe', id: 1 },
        { processed: true, type: 'done' },
      ]);
    });
  });

  describe(`hook only (no concurrent pending entity) ${label}`, () => {
    it('should deliver all hook payloads and reach step when no sleep or incomplete step exists', async () => {
      await setupHydrateMock();
      const ops: Promise<any>[] = [];
      const [payload1, payload2] = await Promise.all([
        dehydrateStepReturnValue('msg1', 'wrun_test', undefined, ops),
        dehydrateStepReturnValue({ done: true }, 'wrun_test', undefined, ops),
      ]);

      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            isWebhook: false,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload1,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payload2,
          },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook({ token: 'test-token' });
        const myStep = useStep('myStep');
        const received: any[] = [];

        for await (const message of hook) {
          received.push(message);
          if ((message as any).done) {
            await myStep();
            return received;
          }
        }
      });

      expect(error).toBeDefined();
      expect(WorkflowSuspension.is(error)).toBe(true);

      const pendingSteps = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'step'
      );
      expect(pendingSteps).toHaveLength(1);
      expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
        'myStep'
      );
    });
  });

  // ─── Prefix replay determinism: Promise.race([sleep, hook]) twice ────
  //
  // Pattern from the diagram:
  //
  //   const s = sleep('1d');                    // wait_created
  //   const r1 = Promise.race([s, hook]);       // hook_received A → hookA wins
  //   // "winner: hookA"
  //                                             // wait_completed (s resolves)
  //   const r2 = Promise.race([s, hook]);       // hook_received B → sleep wins
  //                                             // (s already resolved, beats new hook await)
  //   // "winner: sleep"
  //
  // Full event log (in order):
  //   evnt_0: hook_created
  //   evnt_1: wait_created
  //   evnt_2: hook_received A
  //   evnt_3: wait_completed
  //   evnt_4: hook_received B
  //
  // We assert that the consumer goes down the same deterministic path no
  // matter where replay stops: at every prefix, the workflow either suspends
  // cleanly at the right point with the right invocationsQueue state, or
  // completes with the right race winners. No prefix should ever produce an
  // unconsumed-event error.
  describe(`Promise.race([sleep, hook]) prefix determinism ${label}`, () => {
    type RaceResult = { kind: 'hook'; value: unknown } | { kind: 'sleep' };

    // Build the canonical 5-event log used by every prefix test. Helper takes
    // pre-dehydrated payloads so each test can construct them once.
    function buildFullEventLog(payloadA: unknown, payloadB: unknown): Event[] {
      return [
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            isWebhook: false,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payloadA,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'wait_completed',
          correlationId: `wait_${CORR_IDS[1]}`,
          eventData: { resumeAt: new Date('2099-01-01') },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: {
            token: 'test-token',
            payload: payloadB,
          },
          createdAt: new Date(),
        },
      ];
    }

    // The workflow body is identical across every prefix test. Returned
    // results are wrapped in discriminated unions so the test can tell hook
    // and sleep winners apart.
    function makeWorkflowFn(ctx: WorkflowOrchestratorContext) {
      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);

      return async () => {
        const hook = createHook({ token: 'test-token' });
        const s = sleep('1d');

        const r1: RaceResult = await Promise.race([
          s.then(() => ({ kind: 'sleep' as const })),
          (hook as Promise<unknown>).then((value) => ({
            kind: 'hook' as const,
            value,
          })),
        ]);

        const r2: RaceResult = await Promise.race([
          s.then(() => ({ kind: 'sleep' as const })),
          (hook as Promise<unknown>).then((value) => ({
            kind: 'hook' as const,
            value,
          })),
        ]);

        return [r1, r2];
      };
    }

    async function buildPayloads() {
      const ops: Promise<any>[] = [];
      const [payloadA, payloadB] = await Promise.all([
        dehydrateStepReturnValue('A', 'wrun_test', undefined, ops),
        dehydrateStepReturnValue('B', 'wrun_test', undefined, ops),
      ]);
      return { payloadA, payloadB };
    }

    it('prefix [hook_created]: registers hook, then suspends with wait+hook pending', async () => {
      await setupHydrateMock();
      const { payloadA, payloadB } = await buildPayloads();
      const fullLog = buildFullEventLog(payloadA, payloadB);
      const ctx = setupWorkflowContext(fullLog.slice(0, 1));

      const { error } = await runWithDiscontinuation(ctx, makeWorkflowFn(ctx));

      expect(error).toBeDefined();
      expect(WorkflowSuspension.is(error)).toBe(true);

      // The wait was created in user code (sleep('1d')) but never saw its
      // wait_created event — it sits in invocationsQueue without
      // hasCreatedEvent set. The hook is registered but isn't an
      // invocationsQueue entry (hooks are only queued when an awaiter is
      // pending in some implementations — here, no hook payload arrives so
      // the queue snapshot just shows the wait).
      const pendingWaits = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'wait'
      );
      expect(pendingWaits).toHaveLength(1);
      expect(
        pendingWaits[0].type === 'wait' && pendingWaits[0].hasCreatedEvent
      ).toBeFalsy();
    });

    it('prefix [hook_created, wait_created]: registers wait too, then suspends with neither race resolved', async () => {
      await setupHydrateMock();
      const { payloadA, payloadB } = await buildPayloads();
      const fullLog = buildFullEventLog(payloadA, payloadB);
      const ctx = setupWorkflowContext(fullLog.slice(0, 2));

      const { error } = await runWithDiscontinuation(ctx, makeWorkflowFn(ctx));

      expect(error).toBeDefined();
      expect(WorkflowSuspension.is(error)).toBe(true);

      // The wait_created was consumed: the wait item should now be flagged.
      const pendingWaits = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'wait'
      );
      expect(pendingWaits).toHaveLength(1);
      expect(
        pendingWaits[0].type === 'wait' && pendingWaits[0].hasCreatedEvent
      ).toBe(true);
    });

    it('prefix [..., hook_received A]: race1 resolves with hookA, then suspends before race2 can resolve', async () => {
      await setupHydrateMock();
      const { payloadA, payloadB } = await buildPayloads();
      const fullLog = buildFullEventLog(payloadA, payloadB);
      const ctx = setupWorkflowContext(fullLog.slice(0, 3));

      const { error } = await runWithDiscontinuation(ctx, makeWorkflowFn(ctx));

      // Race 1 resolved with hookA, race 2 is now awaiting both s (not
      // resolved — no wait_completed) and a fresh `await hook` (no more
      // hook_received). With nothing left, the workflow must suspend.
      expect(error).toBeDefined();
      expect(WorkflowSuspension.is(error)).toBe(true);

      // Wait should still be in the queue with hasCreatedEvent === true.
      const pendingWaits = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'wait'
      );
      expect(pendingWaits).toHaveLength(1);
      expect(
        pendingWaits[0].type === 'wait' && pendingWaits[0].hasCreatedEvent
      ).toBe(true);
    });

    it('prefix [..., wait_completed]: race1 = hookA, race2 = sleep, workflow returns cleanly', async () => {
      await setupHydrateMock();
      const { payloadA, payloadB } = await buildPayloads();
      const fullLog = buildFullEventLog(payloadA, payloadB);
      const ctx = setupWorkflowContext(fullLog.slice(0, 4));

      const { result, error } = await runWithDiscontinuation(
        ctx,
        makeWorkflowFn(ctx)
      );

      // No error: race 1 resolves with hookA (hook_received A), then s
      // resolves (wait_completed), and race 2's fresh `await hook` is beaten
      // by the already-resolved s — so sleep wins race 2.
      expect(error).toBeUndefined();
      expect(result).toEqual([{ kind: 'hook', value: 'A' }, { kind: 'sleep' }]);

      // After wait_completed, the wait is removed from invocationsQueue.
      const pendingWaits = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'wait'
      );
      expect(pendingWaits).toHaveLength(0);
    });

    it('full event log [..., hook_received B]: race1 = hookA, race2 = sleep; B is consumed by the still-subscribed hook awaiter without orphan error', async () => {
      await setupHydrateMock();
      const { payloadA, payloadB } = await buildPayloads();
      const fullLog = buildFullEventLog(payloadA, payloadB);
      const ctx = setupWorkflowContext(fullLog);

      const { result, error } = await runWithDiscontinuation(
        ctx,
        makeWorkflowFn(ctx)
      );

      // The race outcome must match the 4-event prefix exactly — adding
      // hook_received B at the end must not change the deterministic path
      // the workflow takes.
      expect(error).toBeUndefined();
      expect(result).toEqual([{ kind: 'hook', value: 'A' }, { kind: 'sleep' }]);

      // The dangling hook awaiter (the loser of race 2) is still subscribed
      // when hook_received B arrives, so the event is consumed and no
      // unconsumed-event error fires.
      const pendingWaits = [...ctx.invocationsQueue.values()].filter(
        (i) => i.type === 'wait'
      );
      expect(pendingWaits).toHaveLength(0);
    });
  });
}

// ─── Run tests in both modes ────────────────────────────

describe('promiseQueue suspension ordering', () => {
  describe('sync deserialization (no encryption)', () => {
    defineTests('sync');
  });

  describe('async deserialization (with encryption)', () => {
    defineTests('async');
  });
});
