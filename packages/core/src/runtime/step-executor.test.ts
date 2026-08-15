import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments } from '../serialization.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { executeStep } from './step-executor.js';

// The retry ceiling (`authoritativeAttempt`) is what bounds a step that keeps
// timing out: a timeout hard-kills the body without writing any error, so the
// error-based guards never fire. These tests assert the ceiling is enforced
// BEFORE the body runs, and only once the attempt number actually exceeds
// maxRetries + 1.

const MAX_RETRIES = 3; // maxRetries + 1 = 4 total attempts allowed

let counter = 0;
function uniqueStepName(): string {
  counter += 1;
  return `step//./step-executor-test//timeoutStep${counter}`;
}

async function setupRunningStep(opts: {
  world: World;
  stepName: string;
  onBody: () => void;
}): Promise<{ runId: string; stepId: string }> {
  const { world, stepName, onBody } = opts;
  const runInput = await dehydrateStepArguments([], 'run', undefined);
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'wf',
      input: runInput,
    },
  });
  const runId = created.run!.runId;
  await world.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {},
  } as never);

  const stepId = 'step_timeout_1';
  const stepInput = await dehydrateStepArguments([], runId, undefined);
  await world.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: { stepName, input: stepInput },
  });

  const stepFn = Object.assign(
    async () => {
      onBody();
      return 'ok';
    },
    { maxRetries: MAX_RETRIES }
  );
  registerStepFunction(stepName, stepFn);

  return { runId, stepId };
}

function makeWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-step-executor-'));
  return createWorld({ dataDir, tag: `t${counter}` });
}

async function eventsFor(
  world: World,
  runId: string,
  stepId: string,
  eventType: Event['eventType']
): Promise<Event[]> {
  const { data } = await world.events.list({ runId });
  return data.filter(
    (e) => e.eventType === eventType && e.correlationId === stepId
  );
}

describe('executeStep — retry ceiling (authoritativeAttempt)', () => {
  afterEach(() => {
    counter += 1;
  });

  it('fails the step WITHOUT running the body once the attempt exceeds maxRetries + 1', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      // Attempt maxRetries + 2 — one past the last allowed retry. This is the
      // delivery a timed-out step would land on with nothing left to try.
      authoritativeAttempt: MAX_RETRIES + 2,
    });

    expect(result.type).toBe('failed');
    // The body must NOT run — retries are already exhausted.
    expect(bodyRuns).toBe(0);

    // The ceiling fires BEFORE the start block, so no new step_started is
    // written for the rejected attempt; the step goes straight to failed.
    const started = await eventsFor(world, runId, stepId, 'step_started');
    expect(started).toHaveLength(0);
    const failures = await eventsFor(world, runId, stepId, 'step_failed');
    expect(failures).toHaveLength(1);
  });

  it('permits (does not pre-empt) the final allowed attempt (maxRetries + 1)', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      // maxRetries + 1 is the last permitted attempt: the ceiling must let it
      // proceed into normal execution rather than pre-emptively failing it.
      authoritativeAttempt: MAX_RETRIES + 1,
    });

    // It got past the ceiling: the step was started (entered normal execution)
    // and was NOT failed by the retry ceiling.
    void bodyRuns;
    expect(result.type).not.toBe('failed');
    const started = await eventsFor(world, runId, stepId, 'step_started');
    expect(started).toHaveLength(1);
    const ceilingFailures = await eventsFor(
      world,
      runId,
      stepId,
      'step_failed'
    );
    expect(ceilingFailures).toHaveLength(0);
  });
});

describe('executeStep — compute instance stamping', () => {
  afterEach(() => {
    counter += 1;
  });

  it('stamps computeInstanceId on step_started without displacing the precondition snapshot', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });

    // computeInstanceId rides in CreateEventParams, which world-local does not
    // persist — so observe the call itself rather than the stored event.
    const createSpy = vi.spyOn(world.events, 'create');

    const preconditionSnapshot = {
      stateUpdatedAt: 1_700_000_000_000,
      stateEventCount: 7,
      stateCursor: 'eid:evnt_01H0000000000000000000000',
    };

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      preconditionSnapshot,
    });

    const started = createSpy.mock.calls.filter(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.[2]?.computeInstanceId).toBe(COMPUTE_INSTANCE_ID);
    // Both ride the same params object — neither may clobber the other, and the
    // three snapshot fields must arrive as one unit.
    expect(started[0]?.[2]).toMatchObject(preconditionSnapshot);
  });
});

describe('executeStep — durable lazy ownership', () => {
  const originalOptimisticInlineStart =
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START;

  afterEach(() => {
    if (originalOptimisticInlineStart === undefined) {
      delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    } else {
      process.env.WORKFLOW_OPTIMISTIC_INLINE_START =
        originalOptimisticInlineStart;
    }
    counter += 1;
  });

  it('does not admit a lazy step body before its durable step_started claim', async () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '1';

    const world = makeWorld();
    const stepName = uniqueStepName();
    const runInput = await dehydrateStepArguments([], 'run', undefined);
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'wf',
        input: runInput,
      },
    });
    const runId = created.run!.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);

    let bodyRuns = 0;
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      return 'ok';
    });

    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const create = vi.fn(
      async (...args: Parameters<World['events']['create']>) => {
        const [, event] = args;
        if (event.eventType === 'step_started') {
          await startGate;
        }
        return world.events.create(...args);
      }
    );
    const delayedWorld = {
      ...world,
      events: { ...world.events, create },
    } as World;
    const stepInput = await dehydrateStepArguments(
      { args: ['input'] },
      runId,
      undefined
    );

    const execution = executeStep({
      world: delayedWorld,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_claim_before_body',
      stepName,
      lazyStepInput: stepInput,
    });

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // The delayed start has reached the world. A pre-claim admission would
    // run the body during this interval.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(bodyRuns).toBe(0);

    releaseStart();
    await execution;
    expect(bodyRuns).toBe(1);
  });
});
