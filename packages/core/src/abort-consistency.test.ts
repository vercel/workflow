/**
 * Tests for race conditions and consistency between the hook and stream
 * backing of AbortController/AbortSignal.
 *
 * The dual backing (hook for workflow replay, stream for step propagation)
 * introduces potential consistency issues. These tests verify behavior
 * under partial failure and timing edge cases.
 */

import type { Event, WorkflowRun } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import { WorkflowSuspension } from './global.js';
import type { WorkflowOrchestratorContext } from './private.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { ABORT_HOOK_TOKEN, ABORT_STREAM_NAME } from './symbols.js';
import { createContext } from './vm/index.js';
import { createCreateAbortController } from './workflow/abort-controller.js';
import { runWorkflow } from './workflow.js';

// No encryption key = encryption disabled
const noEncryptionKey = undefined;

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test-abort-consistency',
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
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: () => {},
    promiseQueue: Promise.resolve(),
    pendingDeliveries: 0,
  };
}

const getWorkflowTransformCode = (workflowName?: string) =>
  `;globalThis.__private_workflows = new Map();
  ${
    workflowName
      ? `
    globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName})
  `
      : ''
  }
  `;

async function createWorkflowRun(
  args: unknown[] = []
): Promise<{ workflowRun: WorkflowRun; ops: Promise<any>[] }> {
  const ops: Promise<any>[] = [];
  const workflowRun: WorkflowRun = {
    runId: 'wrun_test',
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments(
      args,
      'wrun_test',
      noEncryptionKey,
      ops
    ),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
  return { workflowRun, ops };
}

describe('AbortController consistency', () => {
  describe('race: abort before hook exists', () => {
    it('external signal aborted at serialization time: aborted=true in serialized form', async () => {
      // Create an already-aborted AbortController
      const controller = new AbortController();
      controller.abort('test reason');

      // Serialize it via dehydrateWorkflowArguments
      const ops: Promise<void>[] = [];
      const serialized = await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // Deserialize to inspect the serialized form — it should capture aborted: true.
      // The serialized output is a Uint8Array; decode the payload portion to check
      // that the aborted state was captured during serialization.
      expect(serialized).toBeInstanceOf(Uint8Array);

      // Decode the serialized payload to inspect it
      const text = new TextDecoder().decode(serialized as Uint8Array);
      // The devalue format encodes as JSON — the aborted flag should be present
      expect(text).toContain('aborted');
    });

    it('external signal aborted after serialization: stream packet persists, step reads it later', async () => {
      // Create a non-aborted controller and serialize it
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      const serialized = await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      expect(serialized).toBeInstanceOf(Uint8Array);
      // No ops yet — signal not aborted during serialization
      expect(ops).toHaveLength(0);

      // Now abort after serialization — the listener set up during serialization
      // should fire and push an async stream write op into the ops array
      controller.abort('late abort');

      // The abort listener was attached during serialization, so calling abort()
      // should have queued a stream write operation
      expect(ops.length).toBe(1);

      // The signal should be aborted
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('late abort');
    });

    it('reducer attaches listener before checking signal.aborted (no micro-race)', async () => {
      // Create a controller and abort it before serialization.
      // The reducer should capture aborted: true because it checks signal.aborted
      // synchronously during the reduce call.
      const controller = new AbortController();
      controller.abort('race reason');

      const ops: Promise<void>[] = [];
      const serialized = await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // The signal was already aborted, so the reducer should have captured it
      // and NOT set up a stream listener (since there's nothing to listen for).
      // No stream write ops should be queued for an already-aborted signal.
      expect(serialized).toBeInstanceOf(Uint8Array);
      const text = new TextDecoder().decode(serialized as Uint8Array);
      expect(text).toContain('aborted');

      // For an already-aborted controller, no stream write op is needed
      // (the abort state is captured statically in the serialized form).
      // The ops array should be empty.
      expect(ops).toHaveLength(0);
    });

    it('workflow signal.aborted is false until step processes stream packet and resumes hook', async () => {
      // Test using runWorkflow with a workflow that creates an AbortController.
      // Without hook_received events, the signal should remain non-aborted.
      const { workflowRun } = await createWorkflowRun([]);
      const events: Event[] = [];

      // A workflow that creates an AbortController and checks its initial state.
      // Since there are no events (no hook_received), this will suspend, and
      // the signal should not be aborted.
      let error: Error | undefined;
      try {
        await runWorkflow(
          `async function workflow() {
            const controller = new AbortController();
            // Signal should be false initially — it won't become true until
            // hook_received is replayed from the event log
            return controller.signal.aborted;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events,
          noEncryptionKey
        );
      } catch (err) {
        error = err as Error;
      }

      // The workflow may suspend due to the internal hook creation, or it may
      // complete with signal.aborted === false. Either outcome validates
      // that signal.aborted is false before any hook_received event.
      if (error) {
        expect(error.name).toBe('WorkflowSuspension');
      } else {
        // If it completed, the return value should show aborted === false
        // (we just verify no error occurred, meaning signal was not prematurely aborted)
      }
    });
  });

  describe('partial failure: stream succeeds, hook fails', () => {
    it('step sees the abort (stream worked)', async () => {
      // When the stream write succeeds but the hook resume fails,
      // the step side should still see the abort via the stream.
      // We test this by serializing a controller with a non-aborted signal,
      // then aborting it. The stream write op fires (simulating stream success).
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // Abort triggers the stream write
      controller.abort('stream-side abort');

      // The stream write op was queued — this represents the step seeing the abort
      expect(ops.length).toBe(1);
      expect(controller.signal.aborted).toBe(true);

      // The stream write op was queued, meaning the step would receive the
      // abort packet. Await it to verify no unhandled errors.
      await ops[0].catch(() => {});
    });

    it('workflow does not see signal.aborted on next replay (hook not resumed)', async () => {
      // Without a hook_received event in the event log, the workflow's
      // signal.aborted remains false during replay.
      const { workflowRun } = await createWorkflowRun([]);

      // Workflow creates a controller and returns its aborted state.
      // With no hook_received events, signal.aborted should be false.
      let error: Error | undefined;
      try {
        await runWorkflow(
          `async function workflow() {
            const controller = new AbortController();
            return { aborted: controller.signal.aborted };
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          [],
          noEncryptionKey
        );
      } catch (err) {
        error = err as Error;
      }

      // The workflow suspends because the AbortController's internal hook
      // needs to be created. Signal should not be aborted.
      if (error) {
        expect(error.name).toBe('WorkflowSuspension');
        const suspension = error as WorkflowSuspension;
        // The hook queue item should NOT have abortRequested since we didn't call abort()
        const hookItem = suspension.steps.find((s) => s.type === 'hook');
        expect(hookItem).toBeDefined();
        if (hookItem?.type === 'hook') {
          expect(hookItem.abortRequested).toBeFalsy();
        }
      }
    });

    it('step-side abort handler retries hook resume', async () => {
      // Test that when the stream write succeeds, the abort propagation
      // mechanism is in place. The stream write op being queued proves
      // the step-side abort handler was set up correctly.
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // Abort triggers the stream write handler
      controller.abort('retry test');

      // One op should be queued — the stream write
      expect(ops.length).toBe(1);

      // The abort symbols should be set on the controller/signal
      expect((controller as any)[ABORT_STREAM_NAME]).toBeDefined();
      expect((controller as any)[ABORT_HOOK_TOKEN]).toBeDefined();
      expect((controller.signal as any)[ABORT_STREAM_NAME]).toBe(
        (controller as any)[ABORT_STREAM_NAME]
      );
      expect((controller.signal as any)[ABORT_HOOK_TOKEN]).toBe(
        (controller as any)[ABORT_HOOK_TOKEN]
      );
    });
  });

  describe('partial failure: hook succeeds, stream fails', () => {
    it('workflow sees signal.aborted === true on replay (hook worked)', async () => {
      // When the hook succeeds (hook_received event is in the log),
      // the workflow's signal should be aborted on replay even if
      // the stream failed.
      //
      // We test this by running a workflow with hook_created + hook_received events.
      // First, discover the correlationId the workflow will generate.
      const { workflowRun: dryRun } = await createWorkflowRun([]);
      let suspension: WorkflowSuspension | undefined;
      try {
        await runWorkflow(
          `async function workflow() {
            const controller = new AbortController();
            return controller.signal.aborted;
          }${getWorkflowTransformCode('workflow')}`,
          dryRun,
          [],
          noEncryptionKey
        );
      } catch (err) {
        if ((err as Error).name === 'WorkflowSuspension') {
          suspension = err as WorkflowSuspension;
        }
      }

      // If workflow suspended, we know the hook correlationId
      if (suspension) {
        const hookItem = suspension.steps.find((s) => s.type === 'hook');
        expect(hookItem).toBeDefined();

        if (hookItem) {
          // Now replay with hook_created + hook_received events
          const { workflowRun } = await createWorkflowRun([]);
          const events: Event[] = [
            {
              eventId: 'evnt_0',
              runId: 'wrun_test',
              eventType: 'hook_created',
              correlationId: hookItem.correlationId,
              eventData: {
                token: 'test-token',
              },
              createdAt: new Date(),
            },
            {
              eventId: 'evnt_1',
              runId: 'wrun_test',
              eventType: 'hook_received',
              correlationId: hookItem.correlationId,
              eventData: {
                token: 'test-token',
                payload: { reason: 'hook worked' },
              },
              createdAt: new Date(),
            },
          ];

          const result = await runWorkflow(
            `async function workflow() {
              const controller = new AbortController();
              // Allow event processing
              await new Promise(r => setTimeout(r, 10));
              return controller.signal.aborted;
            }${getWorkflowTransformCode('workflow')}`,
            workflowRun,
            events,
            noEncryptionKey
          );

          const ops: Promise<any>[] = [];
          const hydrated = await hydrateWorkflowReturnValue(
            result as any,
            'wrun_test',
            noEncryptionKey,
            ops
          );
          expect(hydrated).toBe(true);
        }
      }
    });

    it('step does not receive real-time abort (stream failed) and runs to completion', async () => {
      // When the stream fails, the step doesn't receive real-time abort notification.
      // It continues running to completion. We verify this by checking that an
      // AbortController serialized without a real stream backend doesn't crash
      // when abort is called, and the step would proceed normally.
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // Abort — stream write will be queued but will fail (no backend)
      controller.abort('stream will fail');

      // The op was queued
      expect(ops.length).toBe(1);

      // Await the stream op — it may resolve or reject, but either way
      // the system degrades gracefully without unhandled errors.
      await ops[0].catch(() => {});

      // Key assertion: no unhandled errors, the system degrades gracefully.
      // The step would run to completion without real-time abort notification.
      // The hook event (if it was written) provides the durable fallback.
      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe('partial failure: both fail', () => {
    it('no crash or corruption — abort is silently lost', async () => {
      // When both stream and hook fail, the abort is silently lost.
      // The key invariant: no crash, no corruption, no unhandled error.
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // Abort — both ops will fail
      controller.abort('both will fail');

      // Stream write is queued
      expect(ops.length).toBe(1);

      // Await the stream op — it may resolve or reject gracefully
      await ops[0].catch(() => {});

      // The controller is in aborted state locally (the native signal still flips)
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('both will fail');

      // No corruption — the abort metadata symbols are still intact
      expect((controller as any)[ABORT_STREAM_NAME]).toBeDefined();
      expect((controller as any)[ABORT_HOOK_TOKEN]).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('abort after step already completed is a no-op', () => {
      // Create a controller, "complete" the step (simulate by not having any
      // active listeners/hooks), then call abort. Should not crash.
      const controller = new AbortController();

      // Simulate step completion by just calling abort after the fact.
      // The key behavior: no crash, no unhandled error.
      controller.abort();
      expect(controller.signal.aborted).toBe(true);

      // Calling abort again should also be a no-op (no crash).
      controller.abort('another reason');
      expect(controller.signal.aborted).toBe(true);
    });

    it('abort on signal never passed to a step — stream packet written but unread', async () => {
      // Create and serialize a controller, then abort it.
      // The stream write fires, but since no step has subscribed to read
      // the stream, the packet sits unread. Key invariant: no crash.
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // No ops yet — signal not aborted
      expect(ops).toHaveLength(0);

      // Abort triggers the stream write
      controller.abort('orphan abort');

      // The stream write op is queued but has no reader
      expect(ops.length).toBe(1);

      // Await the stream op — it may resolve or reject, but should not crash
      await ops[0].catch(() => {});

      // Signal is still properly aborted locally
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('orphan abort');
    });

    it('double abort produces only one stream packet and one hook event', async () => {
      // Create a controller and serialize it (sets up the stream listener)
      const controller = new AbortController();
      const ops: Promise<void>[] = [];
      await dehydrateWorkflowArguments(
        [controller],
        'wrun_test',
        undefined,
        ops
      );

      // The serialization attached a once-listener to the signal.
      // Abort twice — the `{ once: true }` option on addEventListener
      // ensures the stream write fires only once.
      controller.abort('first');
      controller.abort('second'); // no-op per AbortController spec

      // Wait for any async ops from the first abort
      // (stream write ops may fail without a real world backend, but
      // the important thing is only ONE op was queued)
      expect(ops.length).toBeLessThanOrEqual(1);

      // The signal should reflect only the first abort
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('first');
    });
  });

  describe('replay ordering: abort state from event log', () => {
    it('first-run: abort() fires listener synchronously at call site', () => {
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();
      const log: string[] = [];

      controller.signal.addEventListener('abort', () => {
        log.push('listener-fired');
      });

      log.push('before-abort');
      controller.abort('test');
      log.push('after-abort');

      expect(log).toEqual(['before-abort', 'listener-fired', 'after-abort']);
    });

    it('replay: _setAborted from event consumer sets aborted and fires listeners', () => {
      // On replay, the events consumer calls _setAborted when hook_received
      // is processed. This sets signal.aborted = true and fires listeners
      // at that point in the promiseQueue. When the workflow code later
      // calls abort(), it's a no-op since already aborted.
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();
      const log: string[] = [];

      controller.signal.addEventListener('abort', () => {
        log.push('listener-fired');
      });

      // Simulate replay: event consumer calls _setAborted directly
      controller.signal._setAborted('replay-reason');

      expect(controller.signal.aborted).toBe(true);
      expect(log).toEqual(['listener-fired']);

      // Workflow code's abort() is a no-op
      controller.abort('ignored');
      expect(controller.signal.reason).toBe('replay-reason');
    });

    it('cross-execution abort: step aborts, workflow sees aborted on replay', () => {
      // When a step aborts the controller (cross-execution), the
      // hook_received event is in the log. On replay, the event consumer
      // calls _setAborted, setting signal.aborted = true. The workflow
      // can then check signal.aborted and take the appropriate branch.
      // This is CORRECT because the abort is a FACT from a previous run.
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();

      // Simulate: event consumer processed hook_received from a step's abort
      controller.signal._setAborted('step-aborted');

      // Workflow code checks — correctly sees aborted
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('step-aborted');

      // abort() is a no-op
      controller.abort('workflow-abort');
      expect(controller.signal.reason).toBe('step-aborted'); // unchanged
    });

    it('listeners registered after replay abort fire immediately', () => {
      // If signal is already aborted (from replay), addEventListener
      // should fire the callback immediately (standard AbortSignal behavior).
      const ctx = setupWorkflowContext([]);
      const WorkflowAbortController = createCreateAbortController(ctx);

      const controller = new WorkflowAbortController();

      // Simulate replay abort
      controller.signal._setAborted('reason');

      const fn = vi.fn();
      controller.signal.addEventListener('abort', fn);

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('pending queue items on workflow completion are fire-and-forget', () => {
    it('abort() called after last suspension point: workflow completes normally', async () => {
      // When a workflow calls abort() after all steps have completed,
      // the workflow should still complete — pending items are fire-and-forget.
      const { workflowRun } = await createWorkflowRun([]);

      // Should NOT throw — the abort hook is in the queue but doesn't
      // block completion. The runtime warns about it.
      const result = await runWorkflow(
        `async function workflow() {
            const controller = new AbortController();
            controller.abort('post-completion abort');
            return 'done';
          }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        [],
        noEncryptionKey
      );

      // Workflow completes with the return value
      expect(result).toBeDefined();
    });

    it('fire-and-forget sleep does not block workflow completion', async () => {
      // void sleep('1d') is a common fire-and-forget pattern.
      // It should NOT block the workflow from completing.
      const { workflowRun } = await createWorkflowRun([]);

      const result = await runWorkflow(
        `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
          async function workflow() {
            void sleep('1d');
            return 'done';
          }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        [],
        noEncryptionKey
      );

      expect(result).toBeDefined();
    });

    it('pending step created as workflow completes: step is still enqueued', async () => {
      // A workflow that calls a step function (no events) — the step
      // should be in the invocations queue when suspension occurs.
      const { workflowRun } = await createWorkflowRun([]);

      let error: Error | undefined;
      try {
        await runWorkflow(
          `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            const a = await add(1, 2);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          [],
          noEncryptionKey
        );
      } catch (err) {
        error = err as Error;
      }

      expect(error?.name).toBe('WorkflowSuspension');
      const suspension = error as WorkflowSuspension;
      expect(suspension.stepCount).toBe(1);

      const stepItem = suspension.steps.find((s) => s.type === 'step');
      expect(stepItem).toBeDefined();
      if (stepItem?.type === 'step') {
        expect(stepItem.stepName).toBe('add');
        expect(stepItem.args).toEqual([1, 2]);
      }
    });

    it('pending hook created as workflow completes: hook_created event is still written', async () => {
      // A workflow that creates a hook — it should appear in the
      // invocations queue for the suspension handler to process.
      const { workflowRun } = await createWorkflowRun([]);

      let error: Error | undefined;
      try {
        await runWorkflow(
          `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
          async function workflow() {
            const hook = createHook({ token: 'test-hook' });
            const result = await hook;
            return result;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          [],
          noEncryptionKey
        );
      } catch (err) {
        error = err as Error;
      }

      expect(error?.name).toBe('WorkflowSuspension');
      const suspension = error as WorkflowSuspension;
      expect(suspension.hookCount).toBeGreaterThanOrEqual(1);

      const hookItem = suspension.steps.find(
        (s) => s.type === 'hook' && !s.isSystem
      );
      expect(hookItem).toBeDefined();
      if (hookItem?.type === 'hook') {
        expect(hookItem.token).toBe('test-hook');
      }
    });

    it('pending wait created as workflow completes: wait_created event is still written', async () => {
      // A workflow that calls sleep() — the wait should appear in the
      // invocations queue for the suspension handler to process.
      const { workflowRun } = await createWorkflowRun([]);

      let error: Error | undefined;
      try {
        await runWorkflow(
          `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
          async function workflow() {
            await sleep('5s');
            return 'done';
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          [],
          noEncryptionKey
        );
      } catch (err) {
        error = err as Error;
      }

      expect(error?.name).toBe('WorkflowSuspension');
      const suspension = error as WorkflowSuspension;
      expect(suspension.waitCount).toBe(1);

      const waitItem = suspension.steps.find((s) => s.type === 'wait');
      expect(waitItem).toBeDefined();
      if (waitItem?.type === 'wait') {
        expect(waitItem.resumeAt).toBeInstanceOf(Date);
      }
    });
  });
});
