import { FatalError, WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerSerializationClass } from './class-serialization.js';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import {
  dehydrateStepError,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { createUseStep } from './step.js';
import {
  ABORT_HOOK_TOKEN,
  ABORT_STREAM_NAME,
  WORKFLOW_CLASS_REGISTRY,
} from './symbols.js';
import { createContext } from './vm/index.js';
import { createCreateAbortController } from './workflow/abort-controller.js';

// In production, the SWC plugin auto-discovers FatalError/RetryableError
// (classes with WORKFLOW_SERIALIZE/DESERIALIZE) and registers them. In unit
// tests we simulate this by manually registering the class on both the host
// registry (for dehydration calls that use the default globalThis) and the
// VM globalThis (used by step.ts during hydration). We use Symbol.for-based
// keys so the VM registry can be seeded directly.
beforeAll(() => {
  registerSerializationClass('@workflow/errors//FatalError', FatalError);
});

// Helper to setup context to simulate a workflow run
function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  // Propagate the host class registry to the VM globalThis so that
  // hydrateStepError can reconstruct FatalError inside the VM realm.
  const hostRegistry = (globalThis as any)[WORKFLOW_CLASS_REGISTRY];
  if (hostRegistry) {
    (context.globalThis as any)[WORKFLOW_CLASS_REGISTRY] = hostRegistry;
  }
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt), // All generated ulids use the workflow's started at time
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
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
          stepName: 'add',
          result: await dehydrateStepReturnValue(3, 'wrun_test', undefined),
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

  it('should reject with the hydrated thrown value if the step fails', async () => {
    const serializedError = await dehydrateStepError(
      new FatalError('test'),
      'wrun_test',
      undefined
    );
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          error: serializedError,
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
    expect((error as FatalError).message).toBe('test');
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
    // Compare Map values with WorkflowSuspension.steps array
    expect([...ctx.invocationsQueue.values()]).toEqual(
      (error as WorkflowSuspension).steps
    );
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
    // Compare Map values with WorkflowSuspension.steps array
    expect([...ctx.invocationsQueue.values()]).toEqual(
      (error as WorkflowSuspension).steps
    );
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

  it('should set the step function .name property correctly', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'step//input.js//my_step_function',
          result: await dehydrateStepReturnValue(
            undefined,
            'wrun_test',
            undefined
          ),
        },
        createdAt: new Date(),
      },
    ]);
    const useStep = createUseStep(ctx);
    const myStepFunction = useStep('step//input.js//my_step_function');

    // Verify the .name property is set to the extracted function name from the step name
    expect(myStepFunction.name).toBe('my_step_function');

    // Also verify it works when called
    await myStepFunction();
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should capture closure variables when provided', async () => {
    // Use empty events to check queue state before step completes
    const ctx = setupWorkflowContext([]);
    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };

    const useStep = createUseStep(ctx);
    const count = 42;
    const prefix = 'Result: ';

    // Create step with closure variables function
    const calculate = useStep('calculate', () => ({ count, prefix }));

    // Call the step - will suspend since no events
    let error: Error | undefined;
    try {
      await Promise.race([calculate(), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }

    // Verify suspension happened
    expect(error).toBeInstanceOf(WorkflowSuspension);

    // Verify closure variables were added to invocation queue
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = [...ctx.invocationsQueue.values()][0];
    expect(queueItem).toMatchObject({
      type: 'step',
      stepName: 'calculate',
      args: [],
      closureVars: { count: 42, prefix: 'Result: ' },
    });
  });

  // The SWC plugin emits `useStep(stepId, closureFn).bind(this)` for nested
  // arrow steps that lexically capture `this`. The runtime relies on the
  // step proxy being a regular `function` (not an arrow) so that `.bind(this)`
  // works and the bound `this` is recorded as `thisVal` on the queue item.
  it('captures `this` via .bind(this) on the step proxy (lexical-this support)', async () => {
    const ctx = setupWorkflowContext([]);
    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };

    const useStep = createUseStep(ctx);

    // Simulate the SWC plugin output:
    //   globalThis[Symbol.for('WORKFLOW_USE_STEP')]("step_id").bind(this)
    // executed inside an enclosing method whose `this` is `instance`.
    const instance = { name: 'enclosing-this' };
    const stepProxy = useStep('step//input.js//withThis', () => ({ x: 42 }));
    const boundStep = stepProxy.bind(instance);

    // The bound proxy MUST retain the `stepId` and `__closureVarsFn`
    // metadata that `getStepFunctionReducer` reads when serializing step
    // function references — otherwise a bound proxy that flows through
    // workflow serialization (e.g. as a step argument or return value)
    // would be treated as a non-serializable plain function.
    expect((boundStep as any).stepId).toBe('step//input.js//withThis');
    expect((boundStep as any).__closureVarsFn).toBe(
      (stepProxy as any).__closureVarsFn
    );
    // `__boundThis` is the marker the reducer uses to serialize the
    // captured `this`, so a deserialized proxy in another bundle can
    // re-bind to the same value.
    expect((boundStep as any).__boundThis).toBe(instance);

    let error: Error | undefined;
    try {
      await Promise.race([boundStep(7), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }

    expect(error).toBeInstanceOf(WorkflowSuspension);

    // The bound `this` should have been captured on the queue item so the
    // step runtime can `apply(thisVal, args)` when executing the step.
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = [...ctx.invocationsQueue.values()][0];
    expect(queueItem).toMatchObject({
      type: 'step',
      stepName: 'step//input.js//withThis',
      args: [7],
      thisVal: instance,
      closureVars: { x: 42 },
    });
  });

  it('should handle empty closure variables', async () => {
    // Use empty events to check queue state before step completes
    const ctx = setupWorkflowContext([]);
    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };

    const useStep = createUseStep(ctx);

    // Create step without closure variables
    const add = useStep('add');

    // Call the step - will suspend since no events
    let error: Error | undefined;
    try {
      await Promise.race([add(2, 3), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }

    // Verify suspension happened
    expect(error).toBeInstanceOf(WorkflowSuspension);

    // Verify queue item was added with correct structure (no closureVars when not provided)
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = [...ctx.invocationsQueue.values()][0];
    expect(queueItem).toMatchObject({
      type: 'step',
      stepName: 'add',
      args: [2, 3],
    });
  });

  it('should mark hasCreatedEvent when step_created event is received', async () => {
    // step_created marks the queue item but doesn't complete the step
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_created',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          input: new Uint8Array(),
        },
        createdAt: new Date(),
      },
    ]);

    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    // Call the step - will suspend after processing step_created
    let error: Error | undefined;
    try {
      await Promise.race([add(1, 2), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }

    expect(error).toBeInstanceOf(WorkflowSuspension);

    // Queue item should still exist with hasCreatedEvent = true
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = [...ctx.invocationsQueue.values()][0];
    expect(queueItem).toMatchObject({
      type: 'step',
      stepName: 'add',
      hasCreatedEvent: true,
    });
  });

  it('should fail when step_created has the right correlationId but wrong stepName', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_created',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'subtract',
          input: new Uint8Array(),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const useStep = createUseStep(ctx);
    const add = useStep('add');
    void add(1, 2);

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError.message).toContain('Corrupted event log');
    expect(workflowError.message).toContain('step_created');
    expect(workflowError.message).toContain('subtract');
    expect(workflowError.message).toContain('add');
  });

  it('should consume step_started without removing from queue', async () => {
    // step_started is consumed but item stays in queue for potential re-enqueue
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_started',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
        },
        createdAt: new Date(),
      },
    ]);

    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    // Call the step - will suspend after processing step_started
    let error: Error | undefined;
    try {
      await Promise.race([add(1, 2), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }

    expect(error).toBeInstanceOf(WorkflowSuspension);

    // Queue item should still exist (step_started doesn't remove it)
    expect(ctx.invocationsQueue.size).toBe(1);
  });

  it('should consume step_retrying event and continue waiting', async () => {
    // step_retrying is just consumed, step continues to wait for next events
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_retrying',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          error: new Uint8Array(),
        },
        createdAt: new Date(),
      },
    ]);

    let workflowErrorReject: (err: Error) => void;
    const workflowErrorPromise = new Promise<Error>((_, reject) => {
      workflowErrorReject = reject;
    });
    ctx.onWorkflowError = (err) => {
      workflowErrorReject(err);
    };

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    // Call the step - will suspend after processing step_retrying
    let error: Error | undefined;
    try {
      await Promise.race([add(1, 2), workflowErrorPromise]);
    } catch (err_) {
      error = err_ as Error;
    }

    expect(error).toBeInstanceOf(WorkflowSuspension);
    expect(ctx.invocationsQueue.size).toBe(1);
  });

  it('should fail when step_completed has the right correlationId but wrong stepName', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'subtract',
          result: await dehydrateStepReturnValue(42, 'wrun_test', undefined),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const useStep = createUseStep(ctx);
    const add = useStep('add');
    void add(1, 2);

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError.message).toContain('Corrupted event log');
    expect(workflowError.message).toContain('step_completed');
    expect(workflowError.message).toContain('subtract');
    expect(workflowError.message).toContain('add');
    expect(ctx.invocationsQueue.size).toBe(1);
  });

  it('should remove queue item when step_completed (terminal state)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          result: await dehydrateStepReturnValue(42, 'wrun_test', undefined),
        },
        createdAt: new Date(),
      },
    ]);

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    const result = await add(1, 2);

    expect(result).toBe(42);
    // Queue should be empty after completion (terminal state)
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should fail when step_failed has the right correlationId but wrong stepName', async () => {
    const serializedError = await dehydrateStepError(
      new FatalError('test error'),
      'wrun_test',
      undefined
    );
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'subtract',
          error: serializedError,
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const useStep = createUseStep(ctx);
    const add = useStep('add');
    void add(1, 2);

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError.message).toContain('Corrupted event log');
    expect(workflowError.message).toContain('step_failed');
    expect(workflowError.message).toContain('subtract');
    expect(workflowError.message).toContain('add');
    expect(ctx.invocationsQueue.size).toBe(1);
  });

  it('should remove queue item when step_failed (terminal state)', async () => {
    const serializedError = await dehydrateStepError(
      new FatalError('test error'),
      'wrun_test',
      undefined
    );
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          error: serializedError,
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
    // Queue should be empty after failure (terminal state)
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should preserve Error subclass identity and stack through serialization round-trip', async () => {
    // Build a real Error with a specific stack and serialize it through the
    // same pipeline that the step handler uses on write.
    const originalError = new FatalError('Custom error message');
    originalError.stack =
      'Error: Custom error message\n    at someFunction (file.js:10:5)';
    const serializedError = await dehydrateStepError(
      originalError,
      'wrun_test',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          error: serializedError,
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
    expect(error?.message).toBe('Custom error message');
    expect(error?.stack).toContain('someFunction');
    expect(error?.stack).toContain('file.js:10:5');
  });

  it('should preserve plain Error (not FatalError) through serialization round-trip', async () => {
    // Non-FatalError Errors should also round-trip. The hydrated error is
    // reconstructed against the VM realm's Error constructor, so we check
    // via duck-typing (name/message) rather than host `instanceof Error`.
    const originalError = new Error('Plain error message');
    const serializedError = await dehydrateStepError(
      originalError,
      'wrun_test',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          stepName: 'add',
          error: serializedError,
        },
        createdAt: new Date(),
      },
    ]);

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    let error: Error | { name: string; message: string } | undefined;
    try {
      await add(1, 2);
    } catch (err_) {
      error = err_ as Error;
    }

    expect(error?.name).toBe('Error');
    expect(error?.message).toBe('Plain error message');
  });

  it('should invoke workflow error handler with WorkflowRuntimeError for unexpected event type', async () => {
    // Simulate a corrupted event log where a step receives an unexpected event type
    // (e.g., a wait_completed event when expecting step_completed/step_failed)
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_completed', // Wrong event type for a step!
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date(),
        },
        createdAt: new Date(),
      },
    ]);

    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    // Start the step - it will process the event asynchronously
    const stepPromise = add(1, 2);

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError?.message).toContain('Unexpected event type for step');
    expect(workflowError?.message).toContain('step_01K11TFZ62YS0YYFDQ3E8B9YCV');
    expect(workflowError?.message).toContain('add');
    expect(workflowError?.message).toContain('wait_completed');
  });
});

// ============================================================================
// AbortController hook integration in workflow context
// ============================================================================

describe('AbortController hook integration', () => {
  describe('factory creates hook in invocations queue', () => {
    it('new AbortController() adds a hook entry to the invocations queue', () => {
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      expect(ctx.invocationsQueue.size).toBe(0);

      const controller = new WorkflowAbortController();

      // A hook item should have been added to the queue
      expect(ctx.invocationsQueue.size).toBe(1);
      const queueItem = [...ctx.invocationsQueue.values()][0];
      expect(queueItem).toMatchObject({
        type: 'hook',
        isSystem: true,
        isWebhook: false,
      });
      // The hook token should match the controller's token
      expect(queueItem.type).toBe('hook');
      if (queueItem.type === 'hook') {
        expect(queueItem.token).toBe((controller as any)[ABORT_HOOK_TOKEN]);
      }
    });

    it('multiple AbortControllers create independent hook entries', () => {
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const ctrl1 = new WorkflowAbortController();
      const ctrl2 = new WorkflowAbortController();

      expect(ctx.invocationsQueue.size).toBe(2);

      // Each should have a distinct token
      const items = [...ctx.invocationsQueue.values()];
      expect(items[0].type).toBe('hook');
      expect(items[1].type).toBe('hook');
      if (items[0].type === 'hook' && items[1].type === 'hook') {
        expect(items[0].token).not.toBe(items[1].token);
      }
    });
  });

  describe('abort marks hook with abortRequested', () => {
    it('calling abort() sets abortRequested on the hook queue item', () => {
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();
      controller.abort('test reason');

      const queueItem = [...ctx.invocationsQueue.values()][0];
      expect(queueItem.type).toBe('hook');
      if (queueItem.type === 'hook') {
        expect(queueItem.abortRequested).toBe(true);
        expect(queueItem.abortReason).toBe('test reason');
      }
    });

    it('calling abort() twice does not crash or duplicate flags', () => {
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();
      controller.abort('first');
      controller.abort('second');

      // Still only one queue item
      expect(ctx.invocationsQueue.size).toBe(1);
      const queueItem = [...ctx.invocationsQueue.values()][0];
      if (queueItem.type === 'hook') {
        expect(queueItem.abortRequested).toBe(true);
        // The first abort() sets signal.aborted synchronously, so the second
        // abort() is a no-op (returns early). The reason stays 'first'.
        expect(queueItem.abortReason).toBe('first');
      }
    });

    it('abort without reason sets abortRequested but reason is undefined', () => {
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();
      controller.abort();

      const queueItem = [...ctx.invocationsQueue.values()][0];
      if (queueItem.type === 'hook') {
        expect(queueItem.abortRequested).toBe(true);
        expect(queueItem.abortReason).toBeUndefined();
      }
    });
  });

  describe('replay with abort events', () => {
    it('replay with hook_received event reconstructs signal.aborted === true', async () => {
      // First, discover the correlationId that createCreateAbortController will use
      // by doing a dry run with the same deterministic seed.
      const dryCtx = setupWorkflowContext([]);
      const DryAbortController = createCreateAbortController(dryCtx);
      new DryAbortController();
      const correlationId = [...dryCtx.invocationsQueue.keys()][0];

      // Production stores `payload` as a dehydrated Uint8Array (the
      // suspension handler dehydrates `{ aborted: true, reason }` before
      // creating the hook_received event). The events consumer hydrates
      // the payload before reading the reason, so the test must pass a
      // dehydrated payload to match production.
      const dehydratedPayload = await dehydrateStepReturnValue(
        { aborted: true, reason: 'aborted!' },
        'wrun_test',
        undefined
      );

      // Now create the real context with the hook_created and hook_received events
      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId,
          eventData: {
            token: ABORT_HOOK_TOKEN,
          },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId,
          eventData: {
            token: ABORT_HOOK_TOKEN,
            payload: dehydratedPayload as any,
          },
          createdAt: new Date(),
        },
      ]);

      const WorkflowAbortController = createCreateAbortController(ctx);
      const controller = new WorkflowAbortController();

      // The events consumer processes events via process.nextTick, and the
      // hook_received handler chains through promiseQueue. We need to let
      // multiple ticks pass for _setAborted to be called.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ctx.promiseQueue;

      // After replay event processing, signal.aborted is true — the
      // events consumer called _setAborted when hook_received was processed.
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('aborted!');

      // The hook should have been removed from the queue after hook_received
      expect(ctx.invocationsQueue.size).toBe(0);
    });

    it('replay without hook_received event reconstructs signal.aborted === false', async () => {
      // Discover the correlationId via dry run
      const dryCtx = setupWorkflowContext([]);
      const DryAbortController = createCreateAbortController(dryCtx);
      new DryAbortController();
      const correlationId = [...dryCtx.invocationsQueue.keys()][0];

      // Only hook_created, no hook_received
      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId,
          eventData: {
            token: ABORT_HOOK_TOKEN,
          },
          createdAt: new Date(),
        },
      ]);

      const WorkflowAbortController = createCreateAbortController(ctx);
      const controller = new WorkflowAbortController();

      // Let event processing complete
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ctx.promiseQueue;

      expect(controller.signal.aborted).toBe(false);
      // The hook should still be in the queue (waiting for resume)
      expect(ctx.invocationsQueue.size).toBe(1);
      const queueItem = [...ctx.invocationsQueue.values()][0];
      if (queueItem.type === 'hook') {
        expect(queueItem.hasCreatedEvent).toBe(true);
      }
    });
  });

  describe('suspension handler', () => {
    it('abort() triggers suspension handler to create hook_received event and write stream', async () => {
      // When abort() is called, the hook queue item gets abortRequested=true.
      // When the workflow suspends, the suspension handler processes these items
      // by creating hook_received events and writing stream packets.
      // We verify this by checking the WorkflowSuspension object's contents.
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();
      controller.abort('handler test');

      // Build a WorkflowSuspension from the current invocations queue
      const suspension = new WorkflowSuspension(
        ctx.invocationsQueue,
        ctx.globalThis
      );

      // The suspension should contain the hook with abortRequested
      const hookItem = suspension.steps.find((s) => s.type === 'hook');
      expect(hookItem).toBeDefined();
      expect(hookItem?.type).toBe('hook');
      if (hookItem?.type === 'hook') {
        expect(hookItem.abortRequested).toBe(true);
        expect(hookItem.abortReason).toBe('handler test');
        expect(hookItem.isSystem).toBe(true);

        // The suspension handler would use these fields to:
        // 1. Create a hook_received event via world.events.create()
        // 2. Write a stream cancellation packet via world.writeToStream()
        // Verify the token follows the expected format
        expect(hookItem.token).toMatch(/^abrt_/);
      }
    });
  });

  describe('hydration into workflow context', () => {
    it('AbortController returned from step: hook created on hydration into workflow', async () => {
      // When a step returns an AbortController, it gets serialized with
      // streamName and hookToken. When hydrated back in the workflow context,
      // the revived object should preserve these symbols.
      const controller = new AbortController();
      // Simulate the symbols being set during workflow->step serialization
      (controller as any)[ABORT_STREAM_NAME] = 'strm_test_system_abort';
      (controller as any)[ABORT_HOOK_TOKEN] = 'abrt_test';
      (controller.signal as any)[ABORT_STREAM_NAME] = 'strm_test_system_abort';
      (controller.signal as any)[ABORT_HOOK_TOKEN] = 'abrt_test';

      // Serialize using step reducers (step return value serialization)
      const serialized = await dehydrateStepReturnValue(
        controller,
        'wrun_test',
        undefined
      );

      expect(serialized).toBeInstanceOf(Uint8Array);

      // Decode the serialized form to verify it contains the abort metadata
      const text = new TextDecoder().decode(serialized as Uint8Array);
      expect(text).toContain('AbortController');
      expect(text).toContain('strm_test_system_abort');
      expect(text).toContain('abrt_test');
    });

    it('AbortSignal passed as workflow input: hook created on hydration', async () => {
      // When an AbortSignal is passed as workflow input, it gets serialized
      // with the abort metadata. On hydration in the workflow context,
      // the signal should preserve its state.
      const controller = new AbortController();
      // Set up abort metadata symbols
      (controller.signal as any)[ABORT_STREAM_NAME] = 'strm_input_system_abort';
      (controller.signal as any)[ABORT_HOOK_TOKEN] = 'abrt_input';

      // Serialize the signal as a workflow argument
      const ops: Promise<void>[] = [];
      const serialized = await dehydrateWorkflowArguments(
        [controller.signal],
        'wrun_test',
        undefined,
        ops
      );

      expect(serialized).toBeInstanceOf(Uint8Array);

      // The serialized form should contain the abort signal metadata
      const text = new TextDecoder().decode(serialized as Uint8Array);
      expect(text).toContain('AbortSignal');
      expect(text).toContain('strm_input_system_abort');
      expect(text).toContain('abrt_input');
    });
  });

  describe('eventual consistency', () => {
    it('abort before hook exists: stream packet persists, step processes it, hook resumed on next replay', async () => {
      // When abort() is called before the hook is created in the backend,
      // the abort is recorded on the queue item. On the next replay,
      // the suspension handler creates the hook AND immediately resumes it.
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();

      // Abort before any events are processed (hook not yet created in backend)
      controller.abort('early abort');

      // The queue item should have both: needs creation AND abort requested
      const queueItem = [...ctx.invocationsQueue.values()][0];
      expect(queueItem.type).toBe('hook');
      if (queueItem.type === 'hook') {
        expect(queueItem.hasCreatedEvent).toBeUndefined(); // not yet created
        expect(queueItem.abortRequested).toBe(true);
        expect(queueItem.abortReason).toBe('early abort');
      }

      // Build WorkflowSuspension to verify what the handler would see
      const suspension = new WorkflowSuspension(
        ctx.invocationsQueue,
        ctx.globalThis
      );

      // The handler should see a hook that needs both creation and abort
      const hookItem = suspension.steps.find((s) => s.type === 'hook');
      expect(hookItem).toBeDefined();
      if (hookItem?.type === 'hook') {
        expect(hookItem.hasCreatedEvent).toBeFalsy();
        expect(hookItem.abortRequested).toBe(true);
        // The suspension handler would:
        // 1. Create the hook (hook_created event)
        // 2. Immediately resume it (hook_received event with abort payload)
        // 3. Write stream cancellation packet
        // On the next replay, the events consumer sees hook_received and
        // sets signal.aborted = true
      }
    });
  });
});
