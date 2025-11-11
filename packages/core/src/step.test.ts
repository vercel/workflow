import { FatalError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import { STEP_FUNCTION_NAME_SYMBOL } from './symbols.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';

// Helper to setup context to simulate a workflow run
function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return {
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events),
    invocationsQueue: [],
    generateUlid: () => ulid(workflowStartedAt), // All generated ulids use the workflow's started at time
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
  };
}

describe('createUseStep', () => {
  it('should resolve with the result of a step', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: [3],
        },
        createdAt: new Date(),
      },
    ]);
    const useStep = createUseStep(ctx);
    const add = useStep('add');
    const result = await add(1, 2);
    expect(result).toBe(3);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should reject with a fatal error if the step fails', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          error: 'test',
          fatal: true,
        },
        createdAt: new Date(),
      },
    ]);
    const useStep = createUseStep(ctx);
    const add = useStep('add');
    let error: Error | undefined;
    try {
      await add(1, 2);
    } catch (err_) {
      error = err_ as Error;
    }
    expect(error).toBeInstanceOf(FatalError);
    expect((error as FatalError).message).toContain('test');
    expect((error as FatalError).fatal).toBe(true);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should invoke workflow error handler if step is not run (single)', async () => {
    const ctx = setupWorkflowContext([]);
    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };
    const useStep = createUseStep(ctx);
    const add = useStep('add');
    let error: Error | undefined;
    try {
      await Promise.race([add(1, 2), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }
    expect(error).toBeInstanceOf(WorkflowSuspension);
    expect((error as WorkflowSuspension).message).toBe(
      '1 step has not been run yet'
    );
    expect(ctx.invocationsQueue).toEqual((error as WorkflowSuspension).steps);
    expect((error as WorkflowSuspension).steps).toMatchInlineSnapshot(`
      [
        {
          "args": [
            1,
            2,
          ],
          "correlationId": "step_01K11TFZ62YS0YYFDQ3E8B9YCV",
          "stepName": "add",
          "type": "step",
        },
      ]
    `);
  });

  it('should invoke workflow error handler if step is not run (concurrent)', async () => {
    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });

    const ctx = setupWorkflowContext([]);
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };
    const useStep = createUseStep(ctx);
    const add = useStep('add');
    let error: Error | undefined;
    try {
      await Promise.race([
        add(1, 2),
        add(3, 4),
        add(5, 6),
        workflowErrorPromise,
      ]);
    } catch (err_) {
      error = err_ as Error;
    }
    expect(error).toBeInstanceOf(WorkflowSuspension);
    expect((error as WorkflowSuspension).message).toBe(
      '3 steps have not been run yet'
    );
    expect(ctx.invocationsQueue).toEqual((error as WorkflowSuspension).steps);
    expect((error as WorkflowSuspension).steps).toMatchInlineSnapshot(`
      [
        {
          "args": [
            1,
            2,
          ],
          "correlationId": "step_01K11TFZ62YS0YYFDQ3E8B9YCV",
          "stepName": "add",
          "type": "step",
        },
        {
          "args": [
            3,
            4,
          ],
          "correlationId": "step_01K11TFZ62YS0YYFDQ3E8B9YCW",
          "stepName": "add",
          "type": "step",
        },
        {
          "args": [
            5,
            6,
          ],
          "correlationId": "step_01K11TFZ62YS0YYFDQ3E8B9YCX",
          "stepName": "add",
          "type": "step",
        },
      ]
    `);
  });

  it('should attach STEP_FUNCTION_NAME_SYMBOL to the returned function', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: [42],
        },
        createdAt: new Date(),
      },
    ]);

    const useStep = createUseStep(ctx);
    const myStep = useStep('calculateValue');

    // The returned function should have the symbol attached with the step name
    expect((myStep as any)[STEP_FUNCTION_NAME_SYMBOL]).toBe('calculateValue');
  });

  it('should allow the symbol to be non-writable and non-configurable', async () => {
    const ctx = setupWorkflowContext([]);
    const useStep = createUseStep(ctx);
    const myStep = useStep('immutableStep');

    const descriptor = Object.getOwnPropertyDescriptor(
      myStep as any,
      STEP_FUNCTION_NAME_SYMBOL
    );

    expect(descriptor).toBeDefined();
    expect(descriptor?.value).toBe('immutableStep');
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(descriptor?.enumerable).toBe(false);
  });

  it('should attach symbol to multiple step references independently', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: [1],
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCW',
        eventData: {
          result: [2],
        },
        createdAt: new Date(),
      },
    ]);

    const useStep = createUseStep(ctx);
    const stepA = useStep('stepA');
    const stepB = useStep('stepB');

    expect((stepA as any)[STEP_FUNCTION_NAME_SYMBOL]).toBe('stepA');
    expect((stepB as any)[STEP_FUNCTION_NAME_SYMBOL]).toBe('stepB');

    // Call them to verify they work independently
    const resultA = stepA(1);
    const resultB = stepB(2);

    expect(await resultA).toBe(1);
    expect(await resultB).toBe(2);
  });
});
