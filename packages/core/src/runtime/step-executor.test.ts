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

  it('stamps computeInstanceId on step_started without displacing the slot snapshot', async () => {
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
      stepId,
      stepName,
      slotSnapshot,
    });

    const started = createSpy.mock.calls.filter(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.[2]?.computeInstanceId).toBe(COMPUTE_INSTANCE_ID);
    // Both ride the same params object and neither may clobber the other.
    expect(started[0]?.[2]?.eventCount).toBe(slotSnapshot.eventCount);
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

describe('executeStep — attempt stamping', () => {
  afterEach(() => {
    counter += 1;
  });

  it('states the attempt on step_started', async () => {
    // A World that stores only the log cannot count attempts for itself: the
    // number is on no event unless the writer puts it there, and it is the
    // number the retry ceiling is decided against. See `attemptStamp`.
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 3,
    });

    const [started] = await eventsFor(world, runId, stepId, 'step_started');
    expect(
      (started?.eventData as { attempt?: number } | undefined)?.attempt
    ).toBe(3);
  });

  it('states no attempt when the caller supplied none', async () => {
    // A World that counts for itself must not have its count overwritten by a
    // guess, so the field is omitted rather than defaulted.
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
    });

    const [started] = await eventsFor(world, runId, stepId, 'step_started');
    expect(started?.eventData).not.toHaveProperty('attempt');
  });
});

// A World that materializes no step rows answers a bare `step_started` from
// the event just committed, which carries no input — v4's response was the
// row, whose inputRef was stored at step_created. The executor must then
// hydrate from the dispatch message's bytes, or failing that, read the
// step_created event back. Simulated here by stripping `input` from the
// start response of a materializing world.
function withInputlessStartResponses(world: World): World {
  const events: World['events'] = {
    ...world.events,
    create: (async (runId, data, params) => {
      const result = await world.events.create(runId, data as never, params);
      if (
        (data as { eventType?: string }).eventType === 'step_started' &&
        (result as { step?: { input?: unknown } }).step
      ) {
        const { input: _input, ...step } = (
          result as { step: { input?: unknown } & Record<string, unknown> }
        ).step;
        return { ...result, step };
      }
      return result;
    }) as World['events']['create'],
  };
  return { ...world, events };
}

async function setupStepWithArg(opts: {
  world: World;
  stepName: string;
  arg: string;
  onBody: (arg: unknown) => void;
}): Promise<{ runId: string; stepId: string }> {
  const { world, stepName, arg, onBody } = opts;
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

  const stepId = 'step_input_1';
  const stepInput = await dehydrateStepArguments(
    { args: [arg], closureVars: undefined, thisVal: undefined },
    runId,
    undefined
  );
  await world.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: { stepName, input: stepInput },
  });

  registerStepFunction(stepName, async (bodyArg: unknown) => {
    onBody(bodyArg);
    return 'ok';
  });

  return { runId, stepId };
}

describe('executeStep — step input fallbacks (Worlds without step rows)', () => {
  afterEach(() => {
    counter += 1;
  });

  it('hydrates from the dispatch message when the start response has no input', async () => {
    const world = withInputlessStartResponses(makeWorld());
    const stepName = uniqueStepName();
    const seen: unknown[] = [];
    const { runId, stepId } = await setupStepWithArg({
      world,
      stepName,
      arg: 'from-message',
      onBody: (arg) => seen.push(arg),
    });
    const dispatchedStepInput = await dehydrateStepArguments(
      { args: ['from-message'], closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );

    const listSpy = vi.spyOn(world.events, 'listByCorrelationId');
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      dispatchedStepInput: dispatchedStepInput as never,
    });

    expect(result.type).toBe('completed');
    expect(seen).toEqual(['from-message']);
    // The message bytes answered; no log read-back was needed.
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('reads the step_created event back when neither the response nor the message carries input', async () => {
    const world = withInputlessStartResponses(makeWorld());
    const stepName = uniqueStepName();
    const seen: unknown[] = [];
    const { runId, stepId } = await setupStepWithArg({
      world,
      stepName,
      arg: 'from-log',
      onBody: (arg) => seen.push(arg),
    });

    const listSpy = vi.spyOn(world.events, 'listByCorrelationId');
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
    });

    expect(result.type).toBe('completed');
    expect(seen).toEqual(['from-log']);
    expect(listSpy).toHaveBeenCalled();
  });

  it('does not run the body when no input source exists at all', async () => {
    const world = withInputlessStartResponses(makeWorld());
    const stepName = uniqueStepName();
    const seen: unknown[] = [];
    const { runId, stepId } = await setupStepWithArg({
      world,
      stepName,
      arg: 'unreachable',
      onBody: (arg) => seen.push(arg),
    });

    // The read-back finds no step_created either (e.g. not yet visible).
    vi.spyOn(world.events, 'listByCorrelationId').mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
    });

    // The missing input is an error for the retry path (bounded by the
    // attempt ceiling), never a body execution with undefined arguments.
    expect(result.type).toBe('retry');
    expect(seen).toEqual([]);
  });

  it('prefers the input the start response carries', async () => {
    // Worlds with step rows answer the start from the row; the message bytes
    // must not displace that.
    const world = makeWorld();
    const stepName = uniqueStepName();
    const seen: unknown[] = [];
    const { runId, stepId } = await setupStepWithArg({
      world,
      stepName,
      arg: 'from-row',
      onBody: (arg) => seen.push(arg),
    });
    const dispatchedStepInput = await dehydrateStepArguments(
      { args: ['from-message'], closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      dispatchedStepInput: dispatchedStepInput as never,
    });

    expect(result.type).toBe('completed');
    expect(seen).toEqual(['from-row']);
  });
});
