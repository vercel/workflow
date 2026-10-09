import type { Event, WorkflowRun } from '@workflow/world';
import { assert, describe, expect, it } from 'vitest';
import { DEFERRED_CHECK_DELAY_MS } from './events-consumer.js';
import { dehydrateWorkflowArguments } from './serialization.js';
import { runWorkflow } from './workflow.js';

/**
 * Regression tests for vercel/workflow#4231.
 *
 * Building a session arms two things long before the replay that uses them:
 * the `EventsConsumer` starts walking the log as soon as the structural
 * lifecycle consumer subscribes, and `initialInterruption` is the promise
 * `onWorkflowError` rejects to interrupt that replay. Nothing races that
 * promise until `waitForExecution` at the very end of the build, and
 * everything in between can throw — the workflow not being registered in this
 * deployment is the reported case, but a bundle that will not evaluate or
 * input that will not hydrate land the same way.
 *
 * When one of them does, the caller has its error and the runtime records the
 * run as failed. The walk, meanwhile, is sitting on an event no consumer will
 * ever claim (the workflow body never ran, so nothing subscribed), with its
 * deferred unconsumed-event check already on a timer. That check fires after
 * the run has settled, reaches `onWorkflowError`, and rejects a promise
 * nobody is holding: a process-level `unhandledRejection` on a timer tick,
 * which takes the whole worker down over one unrunnable run.
 */
describe('a replay abandoned during session construction', () => {
  const noEncryptionKey = undefined;
  const runId = 'wrun_01M37SXYRY7TDQ86WY8J0B5F6H';

  /**
   * A log from a run that got as far as creating its first step. `step_created`
   * is ordered and not parkable, so the walk stops on it and schedules the
   * deferred check — the shape any non-terminal run past its first step has.
   */
  async function eventLog(): Promise<Event[]> {
    return [
      {
        eventId: 'evnt_00000000000000000000000001',
        runId,
        eventType: 'run_created',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        eventId: 'evnt_00000000000000000000000002',
        runId,
        eventType: 'run_started',
        createdAt: new Date('2024-01-01T00:00:00.500Z'),
      },
      {
        eventId: 'evnt_00000000000000000000000003',
        runId,
        eventType: 'step_created',
        correlationId: 'step_01M37SXYRYMGBRNGSJZTNAX52K',
        eventData: { stepName: 'record' },
        createdAt: new Date('2024-01-01T00:00:00.600Z'),
      },
    ];
  }

  async function workflowRun(workflowName: string): Promise<WorkflowRun> {
    return {
      runId,
      workflowName,
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, noEncryptionKey, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
  }

  function captureUnhandledRejections() {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    return {
      reasons: () => seen,
      stop: () => process.off('unhandledRejection', onUnhandled),
    };
  }

  /**
   * Wait past the deferred check's window with margin, then give Node a
   * further macrotask boundary to run its unhandled-rejection check.
   */
  const settlePastDeferredCheck = () =>
    new Promise((resolve) => setTimeout(resolve, DEFERRED_CHECK_DELAY_MS * 5));

  it('leaves no unhandled rejection when the workflow is not registered in this deployment', async () => {
    // The deployment that holds this run's workflow has been replaced by one
    // that does not export it, so the replay cannot run at all.
    const workflowCode = `globalThis.__private_workflows = new Map();`;
    const capture = captureUnhandledRejections();

    try {
      await expect(
        runWorkflow(
          workflowCode,
          await workflowRun('missingWorkflow'),
          await eventLog(),
          noEncryptionKey
        )
      ).rejects.toMatchObject({ name: 'WorkflowNotRegisteredError' });

      await settlePastDeferredCheck();

      expect(capture.reasons()).toEqual([]);
    } finally {
      capture.stop();
    }
  });

  it('leaves no unhandled rejection when the workflow bundle throws while evaluating', async () => {
    // Same abandonment, reached by a different throw: the bundle registers the
    // workflow but blows up before the lookup can return it.
    const workflowCode = `globalThis.__private_workflows = new Map();
      throw new Error('bundle blew up');`;
    const capture = captureUnhandledRejections();

    try {
      const error = await runWorkflow(
        workflowCode,
        await workflowRun('brokenBundle'),
        await eventLog(),
        noEncryptionKey
      ).then(
        () => undefined,
        (err: unknown) => err as Error
      );
      assert(error);
      expect(error.message).toContain('bundle blew up');

      await settlePastDeferredCheck();

      expect(capture.reasons()).toEqual([]);
    } finally {
      capture.stop();
    }
  });
});
