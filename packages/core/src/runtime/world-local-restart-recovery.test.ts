/**
 * A world-local restart must not leave a step that was running inline in the
 * previous process waiting out the inline-ownership lease (860s) before it is
 * dispatched again (vercel/workflow#4939).
 *
 * The step is started for real by the runtime in a first World instance, whose
 * step body never returns: that process "exits" with the step's latest
 * `step_started` stamped with a queue message nothing will redeliver. A second
 * World on the same data directory then recovers the run through `start()`,
 * and the run must finish in far less time than the lease. Both workflow VM
 * engines are covered: each derives inline ownership from the event log on its
 * own.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalSingleton } from '@workflow/utils';
import type { Event, World } from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
} from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepError,
} from '../serialization.js';
import { NEAR_DUE_WAIT_WINDOW_SECONDS } from './wait-continuation.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// Pass-through spy proving the QuickJS case really runs on QuickJS.
const quickJSStarts = vi.fn();
vi.mock('./quickjs-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quickjs-runtime.js')>();
  return {
    ...actual,
    startQuickJSWorkflow: (
      ...args: Parameters<typeof actual.startQuickJSWorkflow>
    ) => {
      quickJSStarts();
      return actual.startQuickJSWorkflow(...args);
    },
  };
});

/**
 * Put this test's realm in the state of a freshly started process. The two
 * Worlds below share one realm, so the process-wide state a real restart
 * would discard is reset by hand. Both keys and shape versions mirror their
 * definitions: `stepSingleFlight` in `step-single-flight.ts` and `realmBoot`
 * in world-local's `orphaned-steps.ts`. If either is bumped there, this reset
 * silently targets a stale object and the test times out like an unfixed run;
 * update the key here.
 */
async function simulateProcessRestart() {
  // A new process has none of the dead one's in-flight step executions.
  globalSingleton('@workflow/core//stepSingleFlight', 1, () => ({
    inFlight: new Map(),
  })).inFlight.clear();
  // ...and loaded world-local after the dead process wrote its stamps.
  await new Promise((resolve) => setTimeout(resolve, 2));
  globalSingleton('@workflow/world-local//realmBoot', 1, () => ({
    bootedAt: 0,
  })).bootedAt = Date.now();
}

const STEP_NAME = 'restartRecoveryStep';
const WORKFLOW_CODE = `
  const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(STEP_NAME)});
  async function workflow() {
    return await step();
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

describe('world-local restart recovery of an inline step', () => {
  let dataDir: string;
  const worlds: LocalWorld[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wf-restart-recovery-'));
    quickJSStarts.mockClear();
  });

  afterEach(async () => {
    setWorld(undefined);
    await Promise.all(worlds.splice(0).map((world) => world.close()));
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  function bootWorld(): LocalWorld {
    const world = createWorld({ dataDir });
    worlds.push(world);
    world.registerHandler('__wkf_workflow_', workflowEntrypoint(WORKFLOW_CODE));
    setWorld(world as unknown as World);
    return world;
  }

  async function stepEvents(world: LocalWorld, runId: string) {
    const { data } = await world.events.list({
      runId,
      pagination: { sortOrder: 'asc' },
    });
    return data.filter((e: Event) => e.eventType.startsWith('step_'));
  }

  // A spec 8 run records an inline step's creation as its own `step_created`
  // and stamps the start with its queue message, which world-local releases
  // with a `step_retrying`. A single-orchestrator run (spec 9) records the
  // creation on the `step_started` and stamps no owner: its redelivered
  // orchestrator starts the step again on its own, so nothing is released.
  it.each([
    {
      engine: 'node',
      workflowVm: undefined,
      specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
    },
    {
      engine: 'quickjs',
      workflowVm: 'quickjs',
      specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
    },
    {
      engine: 'node',
      workflowVm: undefined,
      specVersion: SPEC_VERSION_CURRENT,
    },
    {
      engine: 'quickjs',
      workflowVm: 'quickjs',
      specVersion: SPEC_VERSION_CURRENT,
    },
  ])('dispatches the step at once instead of waiting out the lease ($engine, spec $specVersion)', async ({
    workflowVm,
    specVersion,
  }) => {
    const singleOrchestrator = specVersion === SPEC_VERSION_CURRENT;
    const creation = singleOrchestrator ? [] : ['step_created'];
    const release = singleOrchestrator ? [] : ['step_retrying'];
    let bodyRuns = 0;
    let entered!: () => void;
    const firstBodyEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerStepFunction(STEP_NAME, async () => {
      bodyRuns += 1;
      if (bodyRuns === 1) {
        entered();
        // The process exits mid-step: this attempt never finishes.
        return new Promise(() => {});
      }
      return 'done';
    });

    const previous = bootWorld();
    await previous.start();
    const created = await previous.events.create(null, {
      eventType: 'run_created',
      specVersion,
      eventData: {
        deploymentId: 'dpl_restart_recovery',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([], 'wrun_', undefined, []),
        ...(workflowVm && { executionContext: { workflowVm } }),
      },
    });
    const runId = created.run?.runId as string;
    await previous.queue('__wkf_workflow_workflow', { runId });
    await firstBodyEntered;

    const [started] = (await stepEvents(previous, runId)).slice(
      creation.length
    );
    expect(started).toMatchObject({
      eventType: 'step_started',
      eventData: singleOrchestrator
        ? { inline: true }
        : { ownerMessageId: expect.stringMatching(/^msg_/) },
    });
    await previous.close();
    await simulateProcessRestart();

    const restarted = bootWorld();
    const restartedAt = Date.now();
    await restarted.start();

    await vi.waitFor(
      async () => {
        const run = await restarted.runs.get(runId);
        expect(run.status).toBe('completed');
      },
      { timeout: 20_000, interval: 50 }
    );
    // Far below the 860s lease the run used to wait out.
    expect(Date.now() - restartedAt).toBeLessThan(20_000);
    expect(bodyRuns).toBe(2);
    expect(quickJSStarts.mock.calls.length > 0).toBe(workflowVm === 'quickjs');

    const events = await stepEvents(restarted, runId);
    expect(events.map((e) => e.eventType)).toEqual([
      ...creation,
      'step_started',
      ...release,
      'step_started',
      'step_completed',
    ]);
    // The dead attempt counts toward the retry budget.
    expect(
      (await restarted.steps.get(runId, events[0].correlationId as string))
        .attempt
    ).toBe(2);
    if (singleOrchestrator) return;
    const error = await hydrateStepError(
      (events[creation.length + 1].eventData as { error: unknown }).error,
      runId,
      undefined
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The process running this step exited before it finished.'
    );
  });
});

/**
 * world-local's queue is in memory, so a restart loses every message a run
 * had queued: a background step's message and a wait's timer. Its recovery
 * message carries a recovery marker, and a single-orchestrator delivery of
 * it sends them again (see `stepsToReenqueue`); a spec 8 run replays them
 * on its own.
 */
describe('world-local restart recovery of a run suspended on queued work', () => {
  let dataDir: string;
  const worlds: LocalWorld[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wf-restart-suspended-'));
  });

  afterEach(async () => {
    setWorld(undefined);
    vi.unstubAllEnvs();
    await Promise.all(worlds.splice(0).map((world) => world.close()));
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  function bootWorld(code: string): LocalWorld {
    const world = createWorld({ dataDir });
    worlds.push(world);
    world.registerHandler('__wkf_workflow_', workflowEntrypoint(code));
    setWorld(world as unknown as World);
    return world;
  }

  async function eventTypes(world: LocalWorld, runId: string) {
    const { data } = await world.events.list({
      runId,
      pagination: { sortOrder: 'asc' },
    });
    return data.map((e: Event) => e.eventType);
  }

  async function startRun(
    world: LocalWorld,
    specVersion: number,
    workflowVm: string | undefined
  ): Promise<string> {
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion,
      eventData: {
        deploymentId: 'dpl_restart_recovery',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([], 'wrun_', undefined, []),
        ...(workflowVm && { executionContext: { workflowVm } }),
      },
    });
    const runId = created.run?.runId as string;
    await world.queue('__wkf_workflow_workflow', { runId });
    return runId;
  }

  const rows = [
    { engine: 'node', workflowVm: undefined },
    { engine: 'quickjs', workflowVm: 'quickjs' },
  ].flatMap((row) =>
    [
      SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
      SPEC_VERSION_SINGLE_ORCHESTRATOR,
    ].map((specVersion) => ({ ...row, specVersion }))
  );

  // Spec 9 only: a spec 8 run replays its timers on its own. The sleep
  // outlasts the window within which any suspending spec 9 delivery arms a
  // wait's timer whatever its chain, so only the recovery marker arms it.
  it.each(
    rows.filter(
      ({ specVersion }) => specVersion === SPEC_VERSION_SINGLE_ORCHESTRATOR
    )
  )('completes a run that was sleeping when the process exited ($engine, spec $specVersion)', async ({
    workflowVm,
    specVersion,
  }) => {
    const code = `
      const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      async function workflow() {
        await sleep("${NEAR_DUE_WAIT_WINDOW_SECONDS + 2}s");
        return "slept";
      }
      ;globalThis.__private_workflows = new Map();
      globalThis.__private_workflows.set("workflow", workflow);`;
    const previous = bootWorld(code);
    await previous.start();
    const runId = await startRun(previous, specVersion, workflowVm);
    await vi.waitFor(
      async () =>
        expect(await eventTypes(previous, runId)).toContain('wait_created'),
      { timeout: 10_000, interval: 25 }
    );
    // The process exits with the wait's timer in its queue.
    await previous.close();
    await simulateProcessRestart();

    const restarted = bootWorld(code);
    await restarted.start();
    // On Windows the run's status was seen as completed before its
    // `run_completed` was listed, so both are waited for.
    await vi.waitFor(
      async () => {
        expect((await restarted.runs.get(runId)).status).toBe('completed');
        expect(await eventTypes(restarted, runId)).toEqual(
          expect.arrayContaining([
            'wait_created',
            'wait_completed',
            'run_completed',
          ])
        );
      },
      { timeout: (NEAR_DUE_WAIT_WINDOW_SECONDS + 12) * 1000, interval: 50 }
    );
  });

  it.each(
    rows
  )('completes a run whose background step was running when the process exited ($engine, spec $specVersion)', async ({
    workflowVm,
    specVersion,
  }) => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    const stepName = 'restartRecoveryBackgroundStep';
    const code = `
      const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(stepName)});
      async function workflow() {
        return await step();
      }
      ;globalThis.__private_workflows = new Map();
      globalThis.__private_workflows.set("workflow", workflow);`;
    let bodyRuns = 0;
    let entered!: () => void;
    const firstBodyEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      if (bodyRuns === 1) {
        entered();
        // The process exits mid-step: this attempt never finishes.
        return new Promise(() => {});
      }
      return 'done';
    });
    const previous = bootWorld(code);
    await previous.start();
    const runId = await startRun(previous, specVersion, workflowVm);
    await firstBodyEntered;
    const { data } = await previous.events.list({
      runId,
      pagination: { sortOrder: 'asc' },
    });
    // A background step: its own message runs it (spec 8 records no
    // `inline` flag; every step it creates this way is one).
    expect(
      data.find((e: Event) => e.eventType === 'step_created')?.eventData
    ).toMatchObject(
      specVersion === SPEC_VERSION_SINGLE_ORCHESTRATOR ? { inline: false } : {}
    );
    await previous.close();
    await simulateProcessRestart();

    const restarted = bootWorld(code);
    await restarted.start();
    await vi.waitFor(
      async () =>
        expect((await restarted.runs.get(runId)).status).toBe('completed'),
      { timeout: 15_000, interval: 50 }
    );
    expect(bodyRuns).toBe(2);
    const steps = (
      await restarted.events.list({ runId, pagination: {} })
    ).data.filter((e: Event) => e.eventType === 'step_started');
    // The dead attempt counts toward the retry budget.
    expect(
      (await restarted.steps.get(runId, steps[0]?.correlationId as string))
        .attempt
    ).toBe(2);
  });
});
