import { FatalError, WorkflowRuntimeError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { ABORT_HOOK_TOKEN } from './symbols.js';
import { createContext } from './vm/index.js';
import { createCreateAbortController } from './workflow/abort-controller.js';

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
      getPromiseQueue: () => Promise.resolve(),
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt), // All generated ulids use the workflow's started at time
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
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

  it('should reject with a fatal error if the step fails', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          error: 'test',
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
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          error: 'test error',
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

  it('should extract message and stack from object error in step_failed', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          error: {
            message: 'Custom error message',
            stack:
              'Error: Custom error message\n    at someFunction (file.js:10:5)',
          },
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

  it('should fallback to eventData.stack when error object has no stack', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_failed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          error: {
            message: 'Error without stack',
          },
          stack:
            'Fallback stack trace\n    at fallbackFunction (fallback.js:20:10)',
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
    expect(error?.message).toBe('Error without stack');
    expect(error?.stack).toContain('fallbackFunction');
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
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const useStep = createUseStep(ctx);
    const add = useStep('add');

    // Start the step - it will process the event asynchronously
    const stepPromise = add(1, 2);

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

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
        // The first abort() sets abortRequested + abortReason on the queue item.
        // The second abort() also sets them (since signal.aborted is not set
        // synchronously in workflow context — it waits for hook replay). However,
        // the suspension handler will only process the abort once, and the signal
        // state is idempotent via _setAborted's guard.
        expect(queueItem.abortReason).toBe('second');
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

      // Now create the real context with the hook_created and hook_received events
      const ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_created',
          correlationId,
          eventData: {},
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_1',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId,
          eventData: { payload: { reason: 'aborted!' } },
          createdAt: new Date(),
        },
      ]);

      const WorkflowAbortController = createCreateAbortController(ctx);
      const controller = new WorkflowAbortController();

      // The events consumer processes events via process.nextTick, and the
      // hook_received handler chains through promiseQueue. We need to let
      // multiple ticks pass for all events to be consumed and the abort
      // state to propagate.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ctx.promiseQueue;

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
          eventData: {},
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
    it.todo(
      'abort() triggers suspension handler to create hook_received event and write stream'
      // Requires integration test with real world backend — the suspension
      // handler calls world.createEvents() and world.writeStream() which
      // need real infrastructure.
    );
  });

  describe('hydration into workflow context', () => {
    it.todo(
      'AbortController returned from step: hook created on hydration into workflow'
      // Requires integration test — hydration from step return values involves
      // the full workflow orchestrator and deserialization pipeline.
    );

    it.todo(
      'AbortSignal passed as workflow input: hook created on hydration'
      // Requires integration test — input hydration happens in the workflow
      // orchestrator before the workflow function runs.
    );
  });

  describe('eventual consistency', () => {
    it.todo(
      'abort before hook exists: stream packet persists, step processes it, hook resumed on next replay'
      // Requires integration test with real world backend
    );
  });
});
