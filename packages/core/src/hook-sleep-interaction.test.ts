import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createUseStep } from './step.js';
import { createContext } from './vm/index.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

/**
 * These tests verify correct behavior when a hook and sleep share the same
 * workflow context — specifically the scenario where a hook has multiple
 * pending payloads and a concurrent sleep has no wait_completed event.
 *
 * This is a regression test for a bug where the sleep's WorkflowSuspension
 * (queued through promiseQueue when the null event fires) would terminate
 * the workflow before subsequent hook payloads could be delivered, because
 * the sleep's suspension was queued ahead of hook payload resolutions that
 * are only created when the workflow code runs between iterations.
 */

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
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
    onWorkflowError: vi.fn(),
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
  };
  return ctx;
}

describe('hook + sleep interaction', () => {
  it('should deliver all hook payloads before sleep suspension terminates the workflow', async () => {
    // Simulates the agent-stop workflow pattern:
    //   void sleep('1d').then(() => { shouldCancel = true })
    //   for await (const message of hook) { ... }
    //
    // Event log has:
    //   hook_created, wait_created, hook_received x3
    //   (no wait_completed — sleep hasn't elapsed)
    //
    // The bug: sleep's null-event handler queues a WorkflowSuspension through
    // promiseQueue. After the first hook payload resolves, the workflow code
    // creates a new hook promise for the next iteration, but the sleep's
    // suspension is already ahead in the queue, terminating execution before
    // the second payload can be delivered.

    const ops: Promise<any>[] = [];
    const payload1 = await dehydrateStepReturnValue(
      { type: 'subscribe', id: 1 },
      'wrun_test',
      undefined,
      ops
    );
    const payload2 = await dehydrateStepReturnValue(
      { type: 'subscribe', id: 2 },
      'wrun_test',
      undefined,
      ops
    );
    const payload3 = await dehydrateStepReturnValue(
      { type: 'stopped' },
      'wrun_test',
      undefined,
      ops
    );

    // correlation IDs match what the deterministic ULID generator produces
    const hookCorrelationId = 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV';
    const waitCorrelationId = 'wait_01K11TFZ62YS0YYFDQ3E8B9YCW';

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'hook_created',
        correlationId: hookCorrelationId,
        eventData: { token: 'test-token', isWebhook: false },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: waitCorrelationId,
        eventData: { resumeAt: new Date('2099-01-01') },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: hookCorrelationId,
        eventData: { payload: payload1 },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: hookCorrelationId,
        eventData: { payload: payload2 },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_4',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: hookCorrelationId,
        eventData: { payload: payload3 },
        createdAt: new Date(),
      },
    ]);

    // Use the same Promise.race pattern as the real workflow runner (workflow.ts)
    // to ensure the WorkflowSuspension actually terminates the "workflow"
    const workflowDiscontinuation = withResolvers<void>();
    ctx.onWorkflowError = workflowDiscontinuation.reject;

    const createHook = createCreateHook(ctx);
    const sleep = createSleep(ctx);
    const useStep = createUseStep(ctx);

    // Simulate the workflow function
    const workflowFn = async () => {
      const hook = createHook();

      // Start sleep concurrently (not awaited, like `void sleep('1d').then(...)`)
      void sleep('1d');

      const receivedPayloads: any[] = [];
      const myStep = useStep('myStep');

      // Simulate `for await (const message of hook) { ... }`
      for await (const message of hook) {
        receivedPayloads.push(message);

        if ((message as any).type === 'stopped') {
          // After receiving 'stopped', invoke a step
          const stepResult = await myStep();
          return { payloads: receivedPayloads, stepResult };
        }
      }

      return { payloads: receivedPayloads };
    };

    // Race the workflow function against the discontinuation promise,
    // exactly like runWorkflow does
    let result: any;
    let error: any;
    try {
      result = await Promise.race([
        workflowFn(),
        workflowDiscontinuation.promise,
      ]);
    } catch (err) {
      error = err;
    }

    // The workflow should have terminated with a WorkflowSuspension
    expect(error).toBeDefined();
    expect(WorkflowSuspension.is(error)).toBe(true);

    // Critical assertion: The suspension should contain a pending step invocation.
    // This means the workflow processed all 3 hook payloads and reached the
    // `await myStep()` line. In the buggy version, the suspension fires from
    // the sleep BEFORE the workflow reaches the step, so no step is in the queue.
    const pendingItems = [...ctx.invocationsQueue.values()];
    const pendingSteps = pendingItems.filter((item) => item.type === 'step');
    expect(pendingSteps).toHaveLength(1);
    expect(pendingSteps[0].type === 'step' && pendingSteps[0].stepName).toBe(
      'myStep'
    );
  });

  it('should not prematurely suspend when hook has queued payloads and sleep is pending', async () => {
    // Simpler version: hook has 2 payloads, sleep has no wait_completed.
    // Verify both payloads are delivered before the suspension fires.
    const ops: Promise<any>[] = [];
    const payload1 = await dehydrateStepReturnValue(
      'first',
      'wrun_test',
      undefined,
      ops
    );
    const payload2 = await dehydrateStepReturnValue(
      'second',
      'wrun_test',
      undefined,
      ops
    );

    const hookCorrelationId = 'hook_01K11TFZ62YS0YYFDQ3E8B9YCV';
    const waitCorrelationId = 'wait_01K11TFZ62YS0YYFDQ3E8B9YCW';

    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_0',
        runId: 'wrun_test',
        eventType: 'hook_created',
        correlationId: hookCorrelationId,
        eventData: { token: 'test-token', isWebhook: false },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'wait_created',
        correlationId: waitCorrelationId,
        eventData: { resumeAt: new Date('2099-01-01') },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_2',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: hookCorrelationId,
        eventData: { payload: payload1 },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_3',
        runId: 'wrun_test',
        eventType: 'hook_received',
        correlationId: hookCorrelationId,
        eventData: { payload: payload2 },
        createdAt: new Date(),
      },
    ]);

    const workflowDiscontinuation = withResolvers<void>();
    ctx.onWorkflowError = workflowDiscontinuation.reject;

    const createHook = createCreateHook(ctx);
    const sleep = createSleep(ctx);

    const workflowFn = async () => {
      const hook = createHook();
      void sleep('1d');

      const results: any[] = [];
      // Process exactly 2 payloads
      const val1 = await hook;
      results.push(val1);
      const val2 = await hook;
      results.push(val2);

      return results;
    };

    let result: any;
    let error: any;
    try {
      result = await Promise.race([
        workflowFn(),
        workflowDiscontinuation.promise,
      ]);
    } catch (err) {
      error = err;
    }

    // The workflow should have completed successfully with both payloads,
    // NOT terminated early with a WorkflowSuspension.
    // In the buggy version, the sleep's suspension fires after the first
    // payload, causing the Promise.race to settle before payload 2 is delivered.
    expect(error).toBeUndefined();
    expect(result).toEqual(['first', 'second']);
  });
});
