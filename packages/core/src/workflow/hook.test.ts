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
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events),
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
          payload: dehydrateStepReturnValue({ message: 'hello' }, ops),
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

  it('should consume hook_created event and remove from invocations queue', async () => {
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
          payload: dehydrateStepReturnValue({ data: 'test' }, ops),
        },
        createdAt: new Date(),
      },
    ]);

    const createHook = createCreateHook(ctx);
    const hook = createHook();

    // After creating the hook, it should be in the queue
    expect(ctx.invocationsQueue.size).toBe(1);

    const result = await hook;

    // After hook_created is processed, the hook should be removed from the queue
    expect(ctx.invocationsQueue.size).toBe(0);
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
          payload: dehydrateStepReturnValue({ message: 'first' }, ops),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'hook_received',
        correlationId: 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: dehydrateStepReturnValue({ message: 'second' }, ops),
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
});
