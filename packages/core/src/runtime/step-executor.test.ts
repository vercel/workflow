import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments } from '../serialization.js';
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
