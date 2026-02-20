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
import { createStart } from './start.js';

// Helper to setup context to simulate a workflow run
function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const ctx: WorkflowOrchestratorContext = {
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: (event) => {
        ctx.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}. This indicates a corrupted or invalid event log.`
          )
        );
      },
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
  };
  return ctx;
}

describe('createStart', () => {
  it('should resolve with { runId } when step_completed event is received', async () => {
    const serializedResult = await dehydrateStepReturnValue(
      'wrun_child_456',
      'wrun_123',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_created',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'step_started',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: serializedResult,
        },
        createdAt: new Date(),
      },
    ]);

    const startFn = createStart(ctx);
    const result = await startFn({ workflowId: 'test-child-workflow' }, [42]);

    expect(result).toEqual({ runId: 'wrun_child_456' });
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
    expect(ctx.invocationsQueue.size).toBe(0);
  });

  it('should throw WorkflowSuspension when no events are available', async () => {
    const ctx = setupWorkflowContext([]);

    let workflowError: Error | undefined;
    ctx.onWorkflowError = (err) => {
      workflowError = err;
    };

    const startFn = createStart(ctx);
    const startPromise = startFn({ workflowId: 'test-child-workflow' }, [42]);

    // Wait for the error handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workflowError).toBeInstanceOf(WorkflowSuspension);

    // The step should be in the invocations queue
    expect(ctx.invocationsQueue.size).toBe(1);
    const queueItem = Array.from(ctx.invocationsQueue.values())[0];
    expect(queueItem.type).toBe('step');
    if (queueItem.type === 'step') {
      expect(queueItem.stepName).toBe('__workflow_start');
    }
  });

  it('should throw error when workflow has no workflowId', async () => {
    const ctx = setupWorkflowContext([]);

    const startFn = createStart(ctx);

    await expect(startFn({}, [42])).rejects.toThrow(
      "'start' received an invalid workflow function"
    );
  });

  it('should throw error when unsupported option is passed', async () => {
    const ctx = setupWorkflowContext([]);

    const startFn = createStart(ctx);

    await expect(
      startFn({ workflowId: 'test' }, [42], { world: {} as any })
    ).rejects.toThrow(
      "Unsupported option 'world' passed to start() in workflow context"
    );
  });

  it('should allow deploymentId and specVersion options', async () => {
    const serializedResult = await dehydrateStepReturnValue(
      'wrun_child_789',
      'wrun_123',
      undefined
    );

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'step_created',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'step_started',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {},
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_123',
        eventType: 'step_completed',
        correlationId: 'step_01K11TFZ62YS0YYFDQ3E8B9YCV',
        eventData: {
          result: serializedResult,
        },
        createdAt: new Date(),
      },
    ]);

    const startFn = createStart(ctx);
    const result = await startFn({ workflowId: 'test-child-workflow' }, [42], {
      deploymentId: 'dep_123',
      specVersion: 2,
    });

    expect(result).toEqual({ runId: 'wrun_child_789' });
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('should parse options from second argument when no args array is passed', async () => {
    const ctx = setupWorkflowContext([]);

    const startFn = createStart(ctx);

    // Pass options as second argument (no args array) with an unsupported key
    await expect(
      startFn({ workflowId: 'test' }, { world: {} as any })
    ).rejects.toThrow(
      "Unsupported option 'world' passed to start() in workflow context"
    );
  });
});
