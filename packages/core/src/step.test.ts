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
} from './serialization.js';
import { createUseStep } from './step.js';
import { WORKFLOW_CLASS_REGISTRY } from './symbols.js';
import { createContext } from './vm/index.js';

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

  it('should consume step_started without removing from queue', async () => {
    // step_started is consumed but item stays in queue for potential re-enqueue
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_started',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
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

  it('should remove queue item when step_completed (terminal state)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
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
