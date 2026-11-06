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
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalSingleton } from '@workflow/utils';
import type { Event, World } from '@workflow/world';
import {
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
} from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepReturnValue,
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
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    },
    {
      engine: 'quickjs',
      workflowVm: 'quickjs',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    },
  ])('dispatches the step at once instead of waiting out the lease ($engine, spec $specVersion)', async ({
    workflowVm,
    specVersion,
  }) => {
    const singleOrchestrator = specVersion === SPEC_VERSION_SINGLE_ORCHESTRATOR;
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
 * A process that dies after saving a step as completed and before logging its
 * `step_completed` leaves a step the replay never sees finish. The run must
 * finish with the saved result, without running the step body again.
 */
describe('world-local restart recovery of a completed step without its event', () => {
  let dataDir: string;
  const worlds: LocalWorld[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wf-restart-unlogged-'));
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

  /**
   * Runs the workflow until its step body is running, then leaves the state of
   * a process that died between saving the step as completed (with
   * `'saved'`) and logging it. Saving through the storage writes the event
   * too, so the event file is removed. Returns the run, its step, and the
   * step's terminal claim.
   */
  async function completeWithoutEvent(specVersion: number) {
    let bodyRuns = 0;
    let entered!: () => void;
    const firstBodyEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerStepFunction(STEP_NAME, async () => {
      bodyRuns += 1;
      entered();
      // The process exits mid-step; its result is saved below instead.
      return new Promise(() => {});
    });
    const previous = createWorld({ dataDir });
    worlds.push(previous);
    previous.registerHandler(
      '__wkf_workflow_',
      workflowEntrypoint(WORKFLOW_CODE)
    );
    setWorld(previous as unknown as World);
    await previous.start();
    const created = await previous.events.create(null, {
      eventType: 'run_created',
      specVersion,
      eventData: {
        deploymentId: 'dpl_restart_unlogged',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([], 'wrun_', undefined, []),
      },
    });
    const runId = created.run?.runId as string;
    await previous.queue('__wkf_workflow_workflow', { runId });
    await firstBodyEntered;
    const stepId = (await previous.events.list({ runId })).data.find(
      (e: Event) => e.eventType === 'step_started'
    )?.correlationId as string;
    await previous.events.create(runId, {
      eventType: 'step_completed',
      specVersion,
      correlationId: stepId,
      eventData: {
        stepName: STEP_NAME,
        result: await dehydrateStepReturnValue('saved', runId, undefined),
      },
    });
    await previous.close();
    const eventsDir = join(dataDir, 'events', runId);
    for (const file of await readdir(eventsDir)) {
      const event = JSON.parse(await readFile(join(eventsDir, file), 'utf8'));
      if (event.eventType === 'step_completed') {
        await unlink(join(eventsDir, file));
      }
    }
    const claim = join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-${stepId}.terminal`
    );
    return { runId, claim, bodyRuns: () => bodyRuns };
  }

  async function expectSavedResult(world: LocalWorld, runId: string) {
    await vi.waitFor(
      async () => {
        const run = await world.runs.get(runId);
        expect(run.status).toBe('completed');
      },
      { timeout: 20_000, interval: 50 }
    );
    const completed = (await world.events.list({ runId })).data.filter(
      (e: Event) => e.eventType === 'step_completed'
    );
    expect(completed).toHaveLength(1);
  }

  // The previous process's claim names its realm, so startup repair writes
  // the event before the run is delivered again, whatever the claim's age and
  // even where its writer can't be checked (a container restart).
  it.each([
    { specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM },
    { specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR },
  ])('writes the event at startup and finishes with the saved result (spec $specVersion)', async ({
    specVersion,
  }) => {
    const { runId, bodyRuns } = await completeWithoutEvent(specVersion);
    await simulateProcessRestart();

    const restarted = createWorld({ dataDir });
    worlds.push(restarted);
    restarted.registerHandler(
      '__wkf_workflow_',
      workflowEntrypoint(WORKFLOW_CODE)
    );
    setWorld(restarted as unknown as World);
    const restartedAt = Date.now();
    await restarted.start();

    await expectSavedResult(restarted, runId);
    // No wait for the claim's 30 s age rule.
    expect(Date.now() - restartedAt).toBeLessThan(20_000);
    expect(bodyRuns()).toBe(1);
  });

  // A claim whose writer can't be checked and that startup can't date (an
  // older world-local's empty claim, written as this process starts) is taken
  // over only once it is 30 s old. Until then world-local refuses the
  // orchestrator's start with `TooEarlyError`, which the runtime must
  // redeliver, not drop. (A spec 8 run's inline step is not started again
  // before its inline-ownership lease ends, so it isn't covered here.)
  it('redelivers the start until an unverifiable claim is old, then finishes with the saved result (spec 9)', async () => {
    const { runId, claim, bodyRuns } = await completeWithoutEvent(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    await simulateProcessRestart();
    await writeFile(claim, '');

    // Shorten the redelivery the runtime asks for once the claim is aged, so
    // the test doesn't wait 30 s; the delay it asked for is kept to check.
    const delays: number[] = [];
    const restarted = createWorld({ dataDir });
    worlds.push(restarted);
    const handle = workflowEntrypoint(WORKFLOW_CODE);
    restarted.registerHandler('__wkf_workflow_', async (request) => {
      const response = await handle(request);
      let timeoutSeconds = Number.NaN;
      try {
        timeoutSeconds = Number(
          JSON.parse(await response.clone().text()).timeoutSeconds
        );
      } catch {}
      if (!(timeoutSeconds > 1)) return response;
      delays.push(timeoutSeconds);
      const aged = new Date(Date.now() - 31_000);
      await utimes(claim, aged, aged);
      return Response.json({ timeoutSeconds: 1 });
    });
    setWorld(restarted as unknown as World);
    await restarted.start();

    await expectSavedResult(restarted, runId);
    // Redelivered after the time the claim had left, not dropped.
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(20);
    expect(delays[0]).toBeLessThanOrEqual(30);
    expect(bodyRuns()).toBe(1);
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
