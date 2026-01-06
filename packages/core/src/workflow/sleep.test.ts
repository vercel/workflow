import { WorkflowRuntimeError } from '@workflow/errors';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { createContext } from '../vm/index.js';
import { createSleep } from './sleep.js';

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

describe('createSleep', () => {
  it('should resolve when wait_completed event is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);
    await sleep('1s');

    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should throw WorkflowSuspension when no events are available', async () => {
    const ctx = setupWorkflowContext([]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const sleep = createSleep(ctx);

    // Start the sleep - it will process events asynchronously
    const sleepPromise = sleep('1s');

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should invoke workflow error handler with WorkflowRuntimeError for unexpected event type', async () => {
    // Simulate a corrupted event log where a sleep/wait receives an unexpected event type
    // (e.g., a step_completed event when expecting wait_created/wait_completed)
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_completed', // Wrong event type for a wait!
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
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

    const sleep = createSleep(ctx);

    // Start the sleep - it will process events asynchronously
    const sleepPromise = sleep('1s');

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError?.message).toContain('Unexpected event type for wait');
    expect(workflowError?.message).toContain('wait_01K11TFZ62YS0YYFDQ3E8B9YCV');
    expect(workflowError?.message).toContain('step_completed');
  });

  it('should mark wait as having created event when wait_created is received', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:05.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const sleep = createSleep(ctx);

    // Start the sleep - it will process events asynchronously
    const sleepPromise = sleep('5s');

    // Wait for event processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that the wait item has been updated with hasCreatedEvent
    const waitItem = ctx.invocationsQueue.get(
      'wait_01K11TFZ62YS0YYFDQ3E8B9YCV'
    );
    expect(waitItem).toBeDefined();
    expect(waitItem?.type).toBe('wait');
    if (waitItem?.type === 'wait') {
      expect(waitItem.hasCreatedEvent).toBe(true);
    }

    // Should suspend since wait_completed is not yet received
    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should handle hook_received as unexpected event type for wait', async () => {
    // Test with a different unexpected event type to ensure all non-wait events are caught
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'hook_received', // Wrong event type for a wait!
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          payload: { data: 'test' },
        },
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const sleep = createSleep(ctx);
    const sleepPromise = sleep('1s');

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
    expect(workflowError?.message).toContain('Unexpected event type for wait');
    expect(workflowError?.message).toContain('hook_received');
  });

  it('should keep queue item after wait_created (not terminal)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:05.000Z'),
        },
        createdAt: new Date(),
      },
    ]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const sleep = createSleep(ctx);
    const sleepPromise = sleep('5s');

    // Wait for event processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Queue item should still exist (wait_created is not terminal)
    expect(ctx.invocationsQueue.size).toBe(1);
    const waitItem = ctx.invocationsQueue.get(
      'wait_01K11TFZ62YS0YYFDQ3E8B9YCV'
    );
    expect(waitItem).toBeDefined();
    expect(waitItem?.type).toBe('wait');

    // Should suspend since wait_completed is not yet received
    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
  });

  it('should remove queue item when wait_completed (terminal state)', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);

    // Before sleep completes, queue should have the item
    expect(ctx.invocationsQueue.size).toBe(0); // Not added yet

    await sleep('1s');

    // Queue should be empty after completion (terminal state)
    expect(ctx.invocationsQueue.size).toBe(0);
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should resolve with void when wait_completed', async () => {
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_completed',
        correlationId: 'wait_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
    ]);

    const sleep = createSleep(ctx);
    const result = await sleep('1s');

    // sleep() should resolve with void/undefined
    expect(result).toBeUndefined();
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });
});
