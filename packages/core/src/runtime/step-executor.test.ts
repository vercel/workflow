import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments, hydrateStepError } from '../serialization.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { executeStep } from './step-executor.js';
import {
  UNSERIALIZABLE_STEP_INPUT_MARKER,
  unserializableStepInputPlaceholder,
} from './unserializable-step.js';

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
  register?: boolean;
  createStep?: boolean;
}): Promise<{ runId: string; stepId: string }> {
  const { world, stepName, onBody, register = true, createStep = true } = opts;
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
  if (createStep) {
    const stepInput = await dehydrateStepArguments([], runId, undefined);
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName, input: stepInput },
    });
  }

  const stepFn = Object.assign(
    async () => {
      onBody();
      return 'ok';
    },
    { maxRetries: MAX_RETRIES }
  );
  if (register) {
    registerStepFunction(stepName, stepFn);
  }

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

  it('stamps request and compute provenance on step_started without displacing the slot snapshot', async () => {
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

    const slotSnapshot = { eventCount: 7 };

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      requestId: 'req_step_executor',
      stepId,
      stepName,
      slotSnapshot,
    });

    const started = createSpy.mock.calls.filter(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.[2]).toMatchObject({
      requestId: 'req_step_executor',
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
    // All dimensions ride the same params object and neither may clobber another.
    expect(started[0]?.[2]?.eventCount).toBe(slotSnapshot.eventCount);
  });

  it('stamps provenance when a lazy unregistered step is materialized', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
      createStep: false,
    });
    const input = await dehydrateStepArguments([], runId, undefined);
    const createSpy = vi.spyOn(world.events, 'create');

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      requestId: 'req_unregistered',
      stepId,
      stepName,
      lazyStepInput: input,
    });

    expect(result.type).toBe('failed');
    const started = createSpy.mock.calls.find(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started?.[2]).toMatchObject({
      requestId: 'req_unregistered',
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
  });

  it('omits an empty requestId from step_started', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });
    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      requestId: '',
      stepId,
      stepName,
    });

    const started = createSpy.mock.calls.find(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started?.[2]?.requestId).toBeUndefined();
  });

  it('omits requestId from step_started when unavailable', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });
    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
    });

    const started = createSpy.mock.calls.find(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started?.[2]).toMatchObject({
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
    expect(started?.[2]?.requestId).toBeUndefined();
  });

  it('advances the snapshot it sends as its own writes land', async () => {
    // The executor writes twice for one step. If the second write still named
    // the position its caller scheduled against, the World would report the
    // first one back to it on every step, forever.
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });

    // The position the caller would have scheduled against, taken from the log
    // rather than written down, so the seed stays below the slots the executor
    // is about to commit at. Seeding it above them would leave `observeSlot`
    // with nothing to raise and the test would pass without exercising it.
    const { data: seeded } = await world.events.list({ runId });
    const scheduledAt = seeded.length;

    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      slotSnapshot: { eventCount: scheduledAt },
    });

    // world-local mints slots for a run created on this scheme, so every write
    // reads back as a position and each one has to name the position its
    // predecessor landed on.
    const counts = createSpy.mock.calls.map((call) => call[2]?.eventCount);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts[0]).toBe(scheduledAt);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1] as number);
    }
  });
});

// Pre-claimed inline starts: the suspension handler's batched fan-out already
// committed (or lost) the step's step_created + step_started pair, so the
// executor must run the body straight off that verdict — no start write of
// its own on the owned path, no write AT ALL on the lost path.
describe('executeStep — pre-claimed inline start', () => {
  afterEach(() => {
    counter += 1;
  });

  it('runs the body without sending a step_started of its own when owned', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;

    // Commit the pair the suspension batch would have committed.
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
    const stepId = 'step_preclaimed_1';
    // The shape the suspension handler dehydrates for a pair's created row —
    // the body's hydration reads `.args` off it.
    const stepInput = await dehydrateStepArguments(
      { args: [], closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName, input: stepInput },
    });
    const startResult = await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName },
    });
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      return 'ok';
    });

    const createSpy = vi.spyOn(world.events, 'create');
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
      preclaimedStart: {
        owned: true,
        step: { ...startResult.step!, input: stepInput },
        batchPostSentAtMs: Date.now() - 5,
        claimCompletedAtMs: Date.now(),
      },
    });

    expect(result.type).toBe('completed');
    expect(bodyRuns).toBe(1);
    // The executor wrote ONLY the terminal event — the claim was the batch's.
    const eventTypesWritten = createSpy.mock.calls.map(
      (call) => (call[1] as { eventType: string }).eventType
    );
    expect(eventTypesWritten).not.toContain('step_started');
    expect(eventTypesWritten).toContain('step_completed');
    expect(await eventsFor(world, runId, stepId, 'step_started')).toHaveLength(
      1
    );
  });

  it('skips without any write when the pair lost its claim', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      return 'ok';
    });

    const createSpy = vi.spyOn(world.events, 'create');
    const result = await executeStep({
      world,
      workflowRunId: 'wrun_never_used',
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_lost_claim',
      stepName,
      authoritativeAttempt: 1,
      preclaimedStart: { owned: false },
    });

    expect(result).toEqual({ type: 'skipped' });
    expect(bodyRuns).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('skips before the unregistered-step fallback when the claim was lost', async () => {
    const world = makeWorld();
    const createSpy = vi.spyOn(world.events, 'create');

    const result = await executeStep({
      world,
      workflowRunId: 'wrun_never_used',
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_lost_unregistered',
      // Never registered: the owned path would write step_failed here, but a
      // lost claim is not this handler's to fail.
      stepName: 'step//./step-executor-test//neverRegistered',
      preclaimedStart: { owned: false },
    });

    expect(result).toEqual({ type: 'skipped' });
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('executeStep — unserializable-argument placeholder guard', () => {
  afterEach(() => {
    counter += 1;
  });

  it('fails the step without running the body when the stored input is the finalization placeholder', async () => {
    // Simulates the crash window in finalizeUnserializableStep: the
    // step_created (placeholder input) landed but the process died before
    // step_failed. Redelivery dispatches the step through normal crash
    // recovery — the executor must complete the intended failure, not run
    // user code with placeholder arguments.
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
      createStep: false,
    });
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {
        stepName,
        input: (await dehydrateStepArguments(
          unserializableStepInputPlaceholder(),
          runId,
          undefined
        )) as Uint8Array,
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('failed');
    expect(bodyRuns).toBe(0);

    // Fatal — one attempt, no step_retrying, straight to step_failed.
    const retrying = await eventsFor(world, runId, stepId, 'step_retrying');
    expect(retrying).toHaveLength(0);
    const failures = await eventsFor(world, runId, stepId, 'step_failed');
    expect(failures).toHaveLength(1);
    const hydrated = (await hydrateStepError(
      (failures[0].eventData as { error: unknown }).error,
      runId,
      undefined
    )) as Error;
    expect(hydrated.name).toBe('SerializationError');
    expect(hydrated.message).toContain('Failed to serialize step arguments');
  });

  it('does not trip on a genuine input that merely contains the marker string', async () => {
    // The structural flag lives on the triple's top level, which user code
    // never controls — an argument that happens to equal the display marker
    // must execute normally.
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
      createStep: false,
    });
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {
        stepName,
        input: (await dehydrateStepArguments(
          {
            args: [UNSERIALIZABLE_STEP_INPUT_MARKER],
            closureVars: [],
            thisVal: undefined,
          },
          runId,
          undefined
        )) as Uint8Array,
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('completed');
    expect(bodyRuns).toBe(1);
  });
});
