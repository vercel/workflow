import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';

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
    deserializationChain: Promise.resolve(),
  };
}

describe('async deserialization ordering', () => {
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
    const hydrateStub = vi
      .spyOn(serialization, 'hydrateStepReturnValue')
      .mockImplementation(async (...args) => {
        callCount++;
        const thisCall = callCount;
        // First call (step A): slow. Second call (step B): fast.
        const delay = thisCall === 1 ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      });

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

    hydrateStub.mockRestore();
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
    const hydrateStub = vi
      .spyOn(serialization, 'hydrateStepReturnValue')
      .mockImplementation(async (...args) => {
        callCount++;
        const thisCall = callCount;
        // Decreasing delays: 60ms, 30ms, 5ms — maximizes chance of out-of-order resolution
        const delays = [60, 30, 5];
        const delay = delays[thisCall - 1] ?? 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return originalHydrate(...args);
      });

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

    hydrateStub.mockRestore();
  });
});
