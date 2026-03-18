import { describe, expect, it } from 'vitest';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import type { Event } from '@workflow/world';
import { EventsConsumer } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { WORKFLOW_CLASS_REGISTRY } from '../symbols.js';
import { createContext } from '../vm/index.js';
import { createWorkflowRun } from './run.js';

function setupWorkflowContext(
  events: Event[] = []
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_123',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: () => {},
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    pendingDeliveries: 0,
  };
  return ctx;
}

describe('WorkflowRun', () => {
  it('should have __serializable marker set to "Run"', () => {
    const ctx = setupWorkflowContext();
    const WorkflowRun = createWorkflowRun(ctx);
    expect(WorkflowRun.__serializable).toBe('Run');
  });

  it('should expose runId from constructor', () => {
    const ctx = setupWorkflowContext();
    const WorkflowRun = createWorkflowRun(ctx);
    const run = new WorkflowRun('wrun_test_456');
    expect(run.runId).toBe('wrun_test_456');
  });

  it('should register in the class registry', () => {
    const ctx = setupWorkflowContext();
    const WorkflowRun = createWorkflowRun(ctx);
    const vmGlobal = ctx.globalThis as any;
    const registry = vmGlobal[WORKFLOW_CLASS_REGISTRY] as Map<string, Function>;
    expect(registry).toBeDefined();
    expect(registry.get('Run')).toBe(WorkflowRun);
  });

  it('should delegate methods to correctly named steps', async () => {
    const ctx = setupWorkflowContext();
    const WorkflowRun = createWorkflowRun(ctx);
    const run = new WorkflowRun('wrun_test_789');

    // Each method/getter should suspend because there are no events,
    // and the step name in the queue should match the expected pattern.
    const methodsToTest = [
      { accessor: () => run.cancel(), expectedSuffix: 'Run.cancel' },
      { accessor: () => run.status, expectedSuffix: 'Run.status' },
      { accessor: () => run.returnValue, expectedSuffix: 'Run.returnValue' },
      { accessor: () => run.workflowName, expectedSuffix: 'Run.workflowName' },
      { accessor: () => run.createdAt, expectedSuffix: 'Run.createdAt' },
      { accessor: () => run.startedAt, expectedSuffix: 'Run.startedAt' },
      { accessor: () => run.completedAt, expectedSuffix: 'Run.completedAt' },
      { accessor: () => run.exists, expectedSuffix: 'Run.exists' },
    ];

    for (const { accessor, expectedSuffix } of methodsToTest) {
      // Reset context for each method
      const freshCtx = setupWorkflowContext();
      const errorPromise = new Promise<Error>((resolve) => {
        freshCtx.onWorkflowError = resolve;
      });
      const FreshWorkflowRun = createWorkflowRun(freshCtx);
      const freshRun = new FreshWorkflowRun('wrun_test_789');

      // Access the property/method (will trigger suspension)
      if (expectedSuffix === 'Run.cancel') {
        freshRun.cancel();
      } else {
        // Access the getter to trigger the step
        (freshRun as any)[expectedSuffix.replace('Run.', '')];
      }

      // Wait for the actual error callback — no arbitrary timeout
      const workflowError = await errorPromise;

      expect(workflowError).toBeInstanceOf(WorkflowSuspension);
      expect(freshCtx.invocationsQueue.size).toBe(1);

      const queueItem = Array.from(freshCtx.invocationsQueue.values())[0];
      expect(queueItem.type).toBe('step');
      if (queueItem.type === 'step') {
        const escapedSuffix = expectedSuffix.replace('.', '\\.');
        expect(queueItem.stepName).toMatch(
          new RegExp(
            `^step//workflow/internal/builtins@[\\d.]+-?[\\w.]*?//${escapedSuffix}$`
          )
        );
        // Each step should receive the runId as its argument
        expect(queueItem.args).toEqual(['wrun_test_789']);
      }
    }
  });
});
