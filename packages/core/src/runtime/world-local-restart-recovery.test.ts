/**
 * A world-local restart must not leave a step that was running inline in the
 * previous process waiting out the inline-ownership lease (860s) before it is
 * dispatched again (vercel/workflow#4939).
 *
 * The step is started for real by the runtime in a first World instance, whose
 * step body never returns: that process "exits" with the step's latest
 * `step_started` stamped with a queue message nothing will redeliver. A second
 * World on the same data directory then recovers the run through `start()`,
 * and the run must finish in far less time than the lease.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalSingleton } from '@workflow/utils';
import type { Event, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepError,
} from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

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
  });

  afterEach(async () => {
    setWorld(undefined);
    await Promise.all(worlds.splice(0).map((world) => world.close()));
    await rm(dataDir, { recursive: true, force: true });
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

  it('dispatches the step at once instead of waiting out the lease', async () => {
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
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_restart_recovery',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([], 'wrun_', undefined, []),
      },
    });
    const runId = created.run?.runId as string;
    await previous.queue('__wkf_workflow_workflow', { runId });
    await firstBodyEntered;

    const [, started] = await stepEvents(previous, runId);
    expect(started).toMatchObject({
      eventType: 'step_started',
      eventData: { ownerMessageId: expect.stringMatching(/^msg_/) },
    });
    await previous.close();
    // A new process starts without the dead one's in-flight step executions.
    globalSingleton('@workflow/core//stepSingleFlight', 1, () => ({
      inFlight: new Map(),
    })).inFlight.clear();

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

    const events = await stepEvents(restarted, runId);
    expect(events.map((e) => e.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_retrying',
      'step_started',
      'step_completed',
    ]);
    // The dead attempt counts toward the retry budget.
    expect(
      (await restarted.steps.get(runId, events[0].correlationId as string))
        .attempt
    ).toBe(2);
    const error = await hydrateStepError(
      (events[2].eventData as { error: unknown }).error,
      runId,
      undefined
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The process running this step exited before it finished.'
    );
  });
});
