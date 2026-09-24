import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FatalError,
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
} from '@workflow/errors';
import type { Event, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { registerStepFunction } from '../private.js';
import {
  dehydrateRunError,
  dehydrateStepArguments,
  hydrateStepError,
} from '../serialization.js';
import { getRun, Run } from './run.js';
import { executeStep } from './step-executor.js';
import { setWorld } from './world.js';

/**
 * `await run.returnValue` against a run that is already terminal.
 *
 * The accessor is a built-in step, so whatever it throws is classified by the
 * step executor's retry policy. A terminal run is immutable: once the accessor
 * has *successfully read* one, re-running the body re-reads the same record and
 * throws the same error. Retrying it only delays the failure reaching the
 * caller and, once the budget is spent, replaces the error the caller is
 * documented to catch (`WorkflowRunFailedError`) with the executor's
 * retry-exhaustion `FatalError` wrapper.
 *
 * Errors from *failing to read* the run (transport blips,
 * `WorkflowRunNotFoundError` for a resilient start) are a different case and
 * stay retryable; they are covered by the sibling suites.
 *
 * See vercel/workflow#4288.
 */
describe('run.returnValue on a terminal run is not retried', () => {
  let dir: string;
  let world: World;
  let counter = 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'returnvalue-terminal-'));
    world = createWorld({ dataDir: dir }) as unknown as World;
    setWorld(world);
  });

  afterEach(async () => {
    setWorld(undefined as unknown as World);
    await rm(dir, { recursive: true, force: true });
  });

  /** A run in `running`, created through the event log like a real one. */
  async function startRun(workflowName: string): Promise<string> {
    const input = await dehydrateStepArguments([], 'run', undefined);
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId: 'dpl_test', workflowName, input },
    });
    const runId = created.run?.runId;
    if (!runId) throw new Error('expected the run to be created');
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);
    return runId;
  }

  /**
   * Run the real `Run.prototype.returnValue` getter as a step of `callerId`,
   * the way the compiler does: the accessor body with the target `Run` as its
   * receiver. Returns the executor's outcome plus the step's own events.
   */
  async function readReturnValueAsStep(
    callerId: string,
    targetId: string
  ): Promise<{
    outcome: Awaited<ReturnType<typeof executeStep>>;
    events: Event[];
  }> {
    counter += 1;
    const stepName = `step//./return-value-terminal//returnValue${counter}`;
    const getter = Object.getOwnPropertyDescriptor(
      Run.prototype,
      'returnValue'
    )?.get;
    if (!getter) throw new Error('expected Run.prototype.returnValue to exist');
    registerStepFunction(stepName, getter.bind(getRun(targetId)));

    const stepId = `step_return_value_${counter}`;
    await world.events.create(callerId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {
        stepName,
        input: await dehydrateStepArguments(
          { args: [], closureVars: undefined, thisVal: undefined },
          callerId,
          undefined
        ),
      },
    });

    const outcome = await executeStep({
      world,
      workflowRunId: callerId,
      workflowName: 'caller',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });

    const { data } = await world.events.list({ runId: callerId });
    return {
      outcome,
      events: data.filter((e) => e.correlationId === stepId),
    };
  }

  /** Hydrate the error a `step_failed` event carries. */
  async function failureOf(callerId: string, events: Event[]) {
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect(failed).toBeDefined();
    return await hydrateStepError(
      (failed as { eventData: { error: unknown } }).eventData.error as never,
      callerId,
      undefined
    );
  }

  it('fails the step on the first attempt for a failed run, keeping WorkflowRunFailedError intact', async () => {
    const targetId = await startRun('target');
    await world.events.create(targetId, {
      eventType: 'run_failed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        error: await dehydrateRunError(
          new FatalError('target failed permanently'),
          targetId,
          undefined
        ),
        errorCode: 'USER_ERROR',
      },
    } as never);

    const callerId = await startRun('caller');
    const { outcome, events } = await readReturnValueAsStep(callerId, targetId);

    // The accessor read the run successfully; the run cannot change. Retrying
    // re-reads the same record, so the step fails here rather than burning the
    // budget first.
    expect(outcome.type).toBe('failed');
    expect(events.map((e) => e.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_failed',
    ]);

    // And the caller catches the error the docs point it at, not the
    // retry-exhaustion wrapper that replaces it once the budget runs out.
    //
    // `runId` / `errorCode` are deliberately not asserted: the generic `Error`
    // reducer carries only name/message/stack/cause across a step boundary, so
    // no SDK error class without a dedicated reducer keeps its extra fields
    // here. That gap is orthogonal to the retry decision, so the run is
    // identified through the message instead.
    const error = (await failureOf(callerId, events)) as Error;
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    expect(error.message).toContain(targetId);
    expect((error.cause as Error).message).toBe('target failed permanently');
  }, 30_000);

  it('fails the step on the first attempt for a cancelled run', async () => {
    const targetId = await startRun('target');
    await world.events.create(targetId, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);

    const callerId = await startRun('caller');
    const { outcome, events } = await readReturnValueAsStep(callerId, targetId);

    expect(outcome.type).toBe('failed');
    expect(events.map((e) => e.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_failed',
    ]);

    const error = await failureOf(callerId, events);
    expect(WorkflowRunCancelledError.is(error)).toBe(true);
  }, 30_000);

  it('still completes the step normally when the run succeeded', async () => {
    const targetId = await startRun('target');
    const { dehydrateWorkflowReturnValue } = await import(
      '../serialization.js'
    );
    await world.events.create(targetId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        output: await dehydrateWorkflowReturnValue('done', targetId),
      },
    } as never);

    const callerId = await startRun('caller');
    const { outcome, events } = await readReturnValueAsStep(callerId, targetId);

    expect(outcome.type).toBe('completed');
    expect(events.map((e) => e.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
  }, 30_000);
});
