import { FatalError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

/**
 * These tests verify that when `hydrateStepReturnValue` performs real async
 * work (e.g., decryption), the promise resolution order of step results
 * remains deterministic — matching the order of events in the event log.
 *
 * Without a fix, if step A's deserialization takes longer than step B's,
 * step B's promise would resolve first, breaking workflow determinism.
 */

// Helper to setup context to simulate a workflow run
function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
  };
}

describe('async deserialization ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve step promises in event log order even when deserialization takes variable time', async () => {
    // Create two step_completed events with real serialized data.
    // We will mock hydrateStepReturnValue to simulate variable async delays.
    const resultA = await dehydrateStepReturnValue(
      'result_A',
      'wrun_test',
      undefined
    );
    const resultB = await dehydrateStepReturnValue(
      'result_B',
      'wrun_test',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { result: resultA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: { result: resultB },
        createdAt: new Date(),
      },
    ]);

    // Mock hydrateStepReturnValue to simulate variable async delay.
    // Step A (first event) takes 50ms, Step B (second event) takes 5ms.
    // Without ordering guarantees, Step B would resolve before Step A.
    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const thisCall = callCount;
        // First call (step A): slow. Second call (step B): fast.
        const delay = thisCall === 1 ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const useStep = createUseStep(ctx);
    const stepA = useStep('stepA');
    const stepB = useStep('stepB');

    // Call both steps — their events will be consumed in order from the event log.
    const promiseA = stepA();
    const promiseB = stepB();

    // Track the order that promises resolve
    const resolveOrder: string[] = [];
    promiseA.then((val) => resolveOrder.push(`A:${val}`));
    promiseB.then((val) => resolveOrder.push(`B:${val}`));

    // Wait for both to resolve
    const [valA, valB] = await Promise.all([promiseA, promiseB]);

    // Values should be correct regardless
    expect(valA).toBe('result_A');
    expect(valB).toBe('result_B');

    // The critical assertion: promises must resolve in event log order (A before B),
    // even though A's deserialization is slower than B's.
    expect(resolveOrder).toEqual(['A:result_A', 'B:result_B']);
  });

  it('should resolve sequential step promises in order with variable async delays', async () => {
    // This simulates a workflow that does: const a = await stepA(); const b = await stepB(a);
    // Here three steps complete in sequence, each with decreasing deserialization time.
    const results = await Promise.all([
      dehydrateStepReturnValue(10, 'wrun_test', undefined),
      dehydrateStepReturnValue(20, 'wrun_test', undefined),
      dehydrateStepReturnValue(30, 'wrun_test', undefined),
    ]);

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { result: results[0] },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: { result: results[1] },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCX',
        eventData: { result: results[2] },
        createdAt: new Date(),
      },
    ]);

    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const thisCall = callCount;
        // Decreasing delays: 60ms, 30ms, 5ms — maximizes chance of out-of-order resolution
        const delays = [60, 30, 5];
        const delay = delays[thisCall - 1] ?? 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const useStep = createUseStep(ctx);
    const step1 = useStep('step1');
    const step2 = useStep('step2');
    const step3 = useStep('step3');

    const promise1 = step1();
    const promise2 = step2();
    const promise3 = step3();

    const resolveOrder: number[] = [];
    promise1.then((val) => resolveOrder.push(val as number));
    promise2.then((val) => resolveOrder.push(val as number));
    promise3.then((val) => resolveOrder.push(val as number));

    const [val1, val2, val3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    expect(val1).toBe(10);
    expect(val2).toBe(20);
    expect(val3).toBe(30);

    // Must resolve in event log order
    expect(resolveOrder).toEqual([10, 20, 30]);
  });

  it('should resolve hook payloads in event log order even when deserialization takes variable time', async () => {
    const ops: Promise<any>[] = [];
    // Create hook events: hook_received with payloads that have variable deserialization time
    const payloadA = await dehydrateStepReturnValue(
      { message: 'first' },
      'wrun_test',
      undefined,
      ops
    );
    const payloadB = await dehydrateStepReturnValue(
      { message: 'second' },
      'wrun_test',
      undefined,
      ops
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { payload: payloadA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { payload: payloadB },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'hook_disposed',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        createdAt: new Date(),
      },
    ]);

    // Mock hydrateStepReturnValue with variable delays.
    // First hook payload: slow (50ms). Second hook payload: fast (5ms).
    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const thisCall = callCount;
        const delay = thisCall === 1 ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Await two payloads from the hook
    const resolveOrder: string[] = [];
    const promiseA = hook.then((val: any) => {
      resolveOrder.push(`A:${val.message}`);
      return val;
    });
    const promiseB = hook.then((val: any) => {
      resolveOrder.push(`B:${val.message}`);
      return val;
    });

    const [valA, valB] = await Promise.all([promiseA, promiseB]);

    expect(valA).toEqual({ message: 'first' });
    expect(valB).toEqual({ message: 'second' });

    // Hook payloads must resolve in event log order
    expect(resolveOrder).toEqual(['A:first', 'B:second']);
  });

  it('should resolve mixed step_completed and step_failed in event log order', async () => {
    // Simulate: step A completes (slow hydration), step B fails, step C completes (fast hydration)
    // All three should resolve/reject in A, B, C order.
    const resultA = await dehydrateStepReturnValue(
      'success_A',
      'wrun_test',
      undefined
    );
    const resultC = await dehydrateStepReturnValue(
      'success_C',
      'wrun_test',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { result: resultA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: { error: 'step B failed' },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCX',
        eventData: { result: resultC },
        createdAt: new Date(),
      },
    ]);

    // Slow hydration for step A to test that step_failed (B) still waits for it
    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const thisCall = callCount;
        // step A: 50ms, step C: 5ms (step B has no hydration)
        const delay = thisCall === 1 ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const useStep = createUseStep(ctx);
    const stepA = useStep('stepA');
    const stepB = useStep('stepB');
    const stepC = useStep('stepC');

    const promiseA = stepA();
    const promiseB = stepB();
    const promiseC = stepC();

    const resolveOrder: string[] = [];
    promiseA.then((val) => resolveOrder.push(`A:${val}`));
    promiseB.catch((err) => resolveOrder.push(`B:${err.message}`));
    promiseC.then((val) => resolveOrder.push(`C:${val}`));

    const results = await Promise.allSettled([promiseA, promiseB, promiseC]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'success_A' });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      FatalError
    );
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'success_C' });

    // Critical: order must be A, B, C regardless of hydration timing
    expect(resolveOrder).toEqual([
      'A:success_A',
      'B:step B failed',
      'C:success_C',
    ]);
  });

  it('should handle many concurrent steps (10) with variable delays in correct order', async () => {
    const count = 10;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        dehydrateStepReturnValue(i, 'wrun_test', undefined)
      )
    );

    // Correlation IDs from the deterministic ULID generator
    const correlationIds = [
      'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
      'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
      'step_01K11TFZ62YS0YYFDQ3E8B9YCX',
      'step_01K11TFZ62YS0YYFDQ3E8B9YCY',
      'step_01K11TFZ62YS0YYFDQ3E8B9YCZ',
      'step_01K11TFZ62YS0YYFDQ3E8B9YD0',
      'step_01K11TFZ62YS0YYFDQ3E8B9YD1',
      'step_01K11TFZ62YS0YYFDQ3E8B9YD2',
      'step_01K11TFZ62YS0YYFDQ3E8B9YD3',
      'step_01K11TFZ62YS0YYFDQ3E8B9YD4',
    ];

    const events: Event[] = results.map((result, i) => ({
      eventId: `evnt_${i}`,
      runId: 'wrun_test',
      eventType: 'step_completed' as const,
      correlationId: correlationIds[i],
      eventData: { result },
      createdAt: new Date(),
    }));

    const ctx = setupWorkflowContext(events);

    // Variable delays: reverse order so step 0 is slowest, step 9 is fastest
    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const delay = (count - callCount + 1) * 10; // 100ms, 90ms, ..., 10ms
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const useStep = createUseStep(ctx);
    const steps = Array.from({ length: count }, (_, i) => useStep(`step${i}`));
    const promises = steps.map((step) => step());

    const resolveOrder: number[] = [];
    for (const [i, p] of promises.entries()) {
      p.then(() => resolveOrder.push(i));
    }

    const values = await Promise.all(promises);

    // All values correct
    for (let i = 0; i < count; i++) {
      expect(values[i]).toBe(i);
    }

    // Must resolve in sequential order 0, 1, 2, ..., 9
    expect(resolveOrder).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  it('should resolve sleep and step promises in event log order', async () => {
    // Simulate: step A completes (slow hydration), sleep B completes, step C completes (fast hydration)
    const resultA = await dehydrateStepReturnValue(
      'step_result',
      'wrun_test',
      undefined
    );
    const resultC = await dehydrateStepReturnValue(
      'after_sleep',
      'wrun_test',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { result: resultA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: { resumeAt: new Date('2024-01-01T00:00:05.000Z') },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCW',
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCX',
        eventData: { result: resultC },
        createdAt: new Date(),
      },
    ]);

    // Slow hydration for step A
    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const thisCall = callCount;
        const delay = thisCall === 1 ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const useStep = createUseStep(ctx);
    const sleep = createSleep(ctx);
    const stepA = useStep('stepA');
    const stepC = useStep('stepC');

    const promiseA = stepA();
    const promiseB = sleep('5s');
    const promiseC = stepC();

    const resolveOrder: string[] = [];
    promiseA.then((val) => resolveOrder.push(`step:${val}`));
    promiseB.then(() => resolveOrder.push('sleep'));
    promiseC.then((val) => resolveOrder.push(`step:${val}`));

    await Promise.all([promiseA, promiseB, promiseC]);

    // Must resolve in event log order: step A, sleep, step C
    expect(resolveOrder).toEqual([
      'step:step_result',
      'sleep',
      'step:after_sleep',
    ]);
  });

  it('should resolve step_completed interleaved with step_completed from different functions in event log order', async () => {
    // Simulate two different step functions whose events are interleaved:
    // stepA_created, stepB_created, stepA_completed (slow), stepB_completed (fast)
    const resultA = await dehydrateStepReturnValue(
      'value_A',
      'wrun_test',
      undefined
    );
    const resultB = await dehydrateStepReturnValue(
      'value_B',
      'wrun_test',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'step_started',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'step_started',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: { result: resultA },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_test',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: { result: resultB },
        createdAt: new Date(),
      },
    ]);

    // Step A hydration is slow, step B is fast
    const serialization = await import('./serialization.js');
    const originalHydrate = serialization.hydrateStepReturnValue;
    let callCount = 0;
    vi.spyOn(serialization, 'hydrateStepReturnValue').mockImplementation(
      async (...args) => {
        callCount++;
        const thisCall = callCount;
        const delay = thisCall === 1 ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      }
    );

    const useStep = createUseStep(ctx);
    const stepA = useStep('stepA');
    const stepB = useStep('stepB');

    // Launch both concurrently (like Promise.all in a workflow)
    const promiseA = stepA();
    const promiseB = stepB();

    const resolveOrder: string[] = [];
    promiseA.then((val) => resolveOrder.push(`A:${val}`));
    promiseB.then((val) => resolveOrder.push(`B:${val}`));

    const [valA, valB] = await Promise.all([promiseA, promiseB]);

    expect(valA).toBe('value_A');
    expect(valB).toBe('value_B');

    // Step A must resolve before step B (event log order)
    expect(resolveOrder).toEqual(['A:value_A', 'B:value_B']);
  });
});
