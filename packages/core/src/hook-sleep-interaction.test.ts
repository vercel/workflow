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
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
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
  return ctx;
}

// Deterministic correlation IDs from the ULID generator with seed 'test'
const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
  '01K11TFZ62YS0YYFDQ3E8B9YCY',
  '01K11TFZ62YS0YYFDQ3E8B9YCZ',
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
          eventData: { token: 'test-token', isWebhook: false },
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
          eventData: { payload: payload1 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload2 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload3 },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook();
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
          eventData: { token: 'test-token', isWebhook: false },
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
          eventData: { payload: payload1 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload2 },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const sleep = createSleep(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook();
        void sleep('1d');

        const val1 = await hook;
        const val2 = await hook;
        return [val1, val2];
      });

      expect(error).toBeUndefined();
      expect(result).toEqual(['first', 'second']);
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
          eventData: { token: 'test-token', isWebhook: false },
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
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload1 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload2 },
          createdAt: new Date(),
        },
      ]);

      const useStep = createUseStep(ctx);
      const createHook = createCreateHook(ctx);

      const { result, error } = await runWithDiscontinuation(ctx, async () => {
        const incompleteStep = useStep('incompleteStep');
        const hook = createHook();

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
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { result: resultA },
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
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_6',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { result: resultB },
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
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_3',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { result: resultA },
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
          eventData: {},
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
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_4',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[1]}`,
          eventData: { result: resultB },
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
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_7',
          runId: 'wrun_test',
          eventType: 'step_completed',
          correlationId: `step_${CORR_IDS[2]}`,
          eventData: { result: resultC },
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
          eventData: { token: 'test-token', isWebhook: false },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload1 },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_2',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: `hook_${CORR_IDS[0]}`,
          eventData: { payload: payload2 },
          createdAt: new Date(),
        },
      ]);

      const createHook = createCreateHook(ctx);
      const useStep = createUseStep(ctx);

      const { error } = await runWithDiscontinuation(ctx, async () => {
        const hook = createHook();
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
