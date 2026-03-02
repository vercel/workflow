import { WorkflowRuntimeError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { dehydrateStepReturnValue } from '../serialization.js';
import { createContext } from '../vm/index.js';
import { createCreateHook } from './hook.js';

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
  };
}

describe('createCreateHook', () => {
  it('should resolve with payload when hook_received event is received', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { message: 'hello' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
    ]);
    const createHook = createCreateHook(ctx);
    const hook = createHook();
    const result = await hook;
    expect(result).toEqual({ message: 'hello' });
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should throw WorkflowSuspension when no events are available', async () => {
    const ctx = setupWorkflowContext([]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Start awaiting the hook - it will process events asynchronously
    const hookPromise = hook.then((v) => v);

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should invoke workflow error handler with WorkflowRuntimeError for unexpected event type', async () => {
    // Simulate a corrupted event log where a hook receives an unexpected event type
    // (e.g., a step_completed event when expecting hook_created/hook_received/hook_disposed)
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed', // Wrong event type for a hook!
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: ['test'],
        },
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Start awaiting the hook - it will process events asynchronously
    const hookPromise = hook.then((v) => v);

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError?.message).toContain('Unexpected event type for hook');
    expect(workflowError?.message).toContain('hook_01K11TFZ62YS0YYFDQ3E8B9YCV');
    expect(workflowError?.message).toContain('step_completed');
  });

  it('should consume hook_created event and mark hasCreatedEvent on queue item', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { data: 'test' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // After creating the hook, it should be in the queue
    expect(ctx.invocationsQueue.size).toBe(1);

    const result = await hook;

    // After hook_created is processed, the hook should remain in the queue with hasCreatedEvent flag
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    expect(queueItem?.hasCreatedEvent).toBe(true);
    expect(result).toEqual({ data: 'test' });
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should finish processing when hook_disposed event is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_disposed',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Wait for event processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The hook consumer should have finished (returned EventConsumerResult.Finished)
    // and should not have called onWorkflowError with a RuntimeError
    const calls = (ctx.onWorkflowError as ReturnType<typeof vi.fn>).mock.calls;
    const runtimeErrors = calls.filter(
      ([err]) => err instanceof WorkflowRuntimeError
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it('should handle multiple hook_received events with iterator', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { message: 'first' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { message: 'second' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_123',
        eventType: 'hook_disposed',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook<{ message: string }>();

    const payloads: { message: string }[] = [];
    for await (const payload of hook) {
      payloads.push(payload);
      if (payloads.length >= 2) break;
    }

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual({ message: 'first' });
    expect(payloads[1]).toEqual({ message: 'second' });
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should include token in error message for unexpected event type', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed', // Wrong event type
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: ['test'],
        },
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    // Create hook with a specific token
    const hook = createHook({ token: 'my-custom-token' });

    // Start awaiting the hook
    const hookPromise = hook.then((v) => v);

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError?.message).toContain('my-custom-token');
  });

  it('should reject with WorkflowRuntimeError when hook_conflict event is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_conflict',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          token: 'my-conflicting-token',
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook({ token: 'my-conflicting-token' });

    // Await should reject with WorkflowRuntimeError
    await expect(hook).rejects.toThrow(WorkflowRuntimeError);
    await expect(hook).rejects.toThrow(/hook-conflict/);
  });

  it('should reject multiple awaits when hook_conflict event is received (iterator case)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_conflict',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          token: 'my-conflicting-token',
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook({ token: 'my-conflicting-token' });

    // First await should reject
    await expect(hook).rejects.toThrow(WorkflowRuntimeError);

    // Subsequent awaits should also reject (simulating iterator pattern)
    await expect(hook).rejects.toThrow(WorkflowRuntimeError);
    await expect(hook).rejects.toThrow(WorkflowRuntimeError);
  });

  it('should be no-op on replay when hook_disposed is in event log', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { data: 'test' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'hook_disposed',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook<{ data: string }>();

    const result = await hook;
    expect(result).toEqual({ data: 'test' });

    // Dispose on replay — should be a no-op (item already removed from queue)
    hook.dispose();

    // hook_disposed is a terminal event, so the item should be removed from the queue
    expect(ctx.invocationsQueue.size).toBe(0);

    // Calling dispose again should also be safe (idempotent)
    hook.dispose();
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should set disposed flag on queue item on first invocation', async () => {
    const ctx = setupWorkflowContext([]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Dispose before any events — should set disposed flag on queue item
    hook.dispose();

    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.disposed).toBe(true);
    }
  });

  it('should be idempotent when dispose is called multiple times', async () => {
    const ctx = setupWorkflowContext([]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    hook.dispose();
    hook.dispose();
    hook.dispose();

    // Queue should still have exactly one item
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.disposed).toBe(true);
    }
  });

  it('should set disposed flag after hook_created replay but before hook_disposed replay', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Wait for events to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Dispose — hook_created was replayed but no hook_disposed in log
    hook.dispose();

    const queueItem = ctx.invocationsQueue.get(
      'hook_01K11TFZ62YS0YYFDQ3E8B9YCV'
    );
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.hasCreatedEvent).toBe(true);
      expect(queueItem.disposed).toBe(true);
    }
  });

  it('should continue yielding buffered payloads despite hook_disposed in event log', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { message: 'first' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { message: 'second' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_123',
        eventType: 'hook_disposed',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook<{ message: string }>();

    // The iterator should yield both payloads even though hook_disposed
    // was eagerly processed by the event consumer before the iterator consumed them
    const payloads: { message: string }[] = [];
    for await (const payload of hook) {
      payloads.push(payload);
      // After consuming payloads, dispose to stop the iterator
      if (payloads.length >= 2) {
        hook.dispose();
      }
    }

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual({ message: 'first' });
    expect(payloads[1]).toEqual({ message: 'second' });

    // hook_disposed is a terminal event, so the item should be removed from the queue
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should remove hook from invocations queue when hook_conflict event is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_conflict',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          token: 'my-conflicting-token',
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook({ token: 'my-conflicting-token' });

    // Hook should initially be in the queue
    expect(ctx.invocationsQueue.size).toBe(1);

    // Try to await (will reject)
    try {
      await hook;
    } catch {
      // Expected to throw
    }

    // After processing conflict event, hook should be removed from queue
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should produce correct WorkflowSuspension when dispose is called after hook_created replay', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Wait for events to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Dispose after hook_created was replayed
    hook.dispose();

    // Create a suspension from current queue state
    const suspension = new WorkflowSuspension(
      ctx.invocationsQueue,
      ctx.globalThis
    );

    // Should count as a hook disposal, not a new hook creation
    expect(suspension.hookCount).toBe(0);
    expect(suspension.hookDisposedCount).toBe(1);
    expect(suspension.stepCount).toBe(0);

    // The queue item should have hasCreatedEvent=true and disposed=true
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.hasCreatedEvent).toBe(true);
      expect(queueItem.disposed).toBe(true);
    }
  });

  it('should produce correct WorkflowSuspension for dispose before first suspension', async () => {
    // Simulates: createHook() then dispose() with no events in the log (first run)
    const ctx = setupWorkflowContext([]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Dispose immediately — no events processed yet
    hook.dispose();

    // Create a suspension from current queue state
    const suspension = new WorkflowSuspension(
      ctx.invocationsQueue,
      ctx.globalThis
    );

    // The item has hasCreatedEvent=false, disposed=true
    // It should be counted as a disposal (not an active hook)
    expect(suspension.hookDisposedCount).toBe(1);
    expect(suspension.hookCount).toBe(0);

    // Verify the queue item flags
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.hasCreatedEvent).toBeUndefined();
      expect(queueItem.disposed).toBe(true);
    }
  });

  it('should handle multiple hooks where only one is disposed', async () => {
    const ctx = setupWorkflowContext([]);

    const createHook = createCreateHook(ctx);
    const hook1 = createHook({ token: 'token-a' });
    const hook2 = createHook({ token: 'token-b' });

    // Only dispose the first hook
    hook1.dispose();

    expect(ctx.invocationsQueue.size).toBe(2);

    const suspension = new WorkflowSuspension(
      ctx.invocationsQueue,
      ctx.globalThis
    );

    // One active hook (needs creation), one disposed hook (needs creation + disposal)
    expect(suspension.hookCount).toBe(1);
    expect(suspension.hookDisposedCount).toBe(1);
  });

  it('should be safe to dispose a conflicted hook', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_conflict',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          token: 'my-conflicting-token',
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook({ token: 'my-conflicting-token' });

    // Await to trigger conflict processing
    try {
      await hook;
    } catch {
      // Expected to throw
    }

    // Queue should be empty (conflict deletes the item)
    expect(ctx.invocationsQueue.size).toBe(0);

    // Dispose should be safe — no item in queue, no crash
    hook.dispose();
    hook.dispose(); // Double dispose also safe

    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should dispose via Symbol.dispose (using keyword pattern)', async () => {
    const ctx = setupWorkflowContext([]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Verify Symbol.dispose is set and callable
    const vmDispose = ctx.globalThis.Symbol.dispose;
    expect(vmDispose).toBeDefined();

    const disposeFn = (hook as any)[vmDispose!];
    expect(typeof disposeFn).toBe('function');

    // Call it — should behave same as hook.dispose()
    disposeFn();

    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.disposed).toBe(true);
    }

    // Calling hook.dispose() again should be idempotent (isDisposed already true)
    hook.dispose();
    expect(ctx.invocationsQueue.size).toBe(1);
  });

  it('should keep hook alive in queue when iterator breaks without dispose', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: await dehydrateStepReturnValue(
            { message: 'hello' },
            'wrun_test',
            undefined,
            ops
          ),
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook<{ message: string }>();

    // Use iterator with break but no dispose()
    for await (const payload of hook) {
      expect(payload).toEqual({ message: 'hello' });
      break; // break without calling hook.dispose()
    }

    // Hook should still be in the queue with hasCreatedEvent but NOT disposed
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = ctx.invocationsQueue.values().next().value;
    expect(queueItem?.type).toBe('hook');
    if (queueItem?.type === 'hook') {
      expect(queueItem.hasCreatedEvent).toBe(true);
      expect(queueItem.disposed).toBeUndefined();
    }
  });

  it('should drain pending promises and trigger suspension when dispose is called while awaiting', async () => {
    const ops: Promise<any>[] = [];
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_created',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Wait for events to process (hook_created consumed, then null → eventLogEmpty)
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Start awaiting — this pushes a resolver to promises[] since payloadsQueue is empty
    const hookPromise = hook.then((v) => v);

    // Now dispose while the promise is pending — this should drain promises
    // and trigger suspension (not leave an orphaned promise)
    hook.dispose();

    // Wait for the async suspension handler
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowSuspension);

    // The suspension should include the disposed hook
    if (WorkflowSuspension.is(workflowError)) {
      expect(workflowError.hookDisposedCount).toBe(1);
    }
  });

  it('should suspend when awaiting a disposed hook on first invocation', async () => {
    const ctx = setupWorkflowContext([]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // Dispose first
    hook.dispose();

    // Then await — the event log is empty, so this should trigger suspension
    const hookPromise = hook.then((v) => v);

    // Wait for the async error handler
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowSuspension);

    // The suspension should include the disposed hook item
    if (WorkflowSuspension.is(workflowError)) {
      expect(workflowError.hookDisposedCount).toBe(1);
      expect(workflowError.hookCount).toBe(0);
    }
  });
});
