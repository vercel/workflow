import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// World round trips an orchestrator makes per inline step. On world-vercel
// each one is a network round trip on the step-to-step path, so these are
// latency budgets, not implementation details.

registerStepFunction('rt_inc', async (n: number) => n + 1);

const STEPS = 20;

const sequentialSteps = `const inc = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("rt_inc");
  async function workflow(steps) {
    let n = 0;
    for (let i = 0; i < steps; i++) n = await inc(n);
    return n;
  }${registerWorkflow()}`;

/** World calls made after the run's setup (the load and `run_started`). */
function afterSetup(world: AppendOnlyWorld) {
  return {
    creates: world.createCalls,
    lists: world.listCalls.length,
  };
}

beforeEach(() => {
  // A poll during a step body would be a list this test does not count.
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('orchestrator World round trips (%s engine)', (engine) => {
  it('creates and starts each inline step in one write, and completes it in a second', async () => {
    const { world } = await setupOrchestratorRun(
      sequentialSteps,
      [STEPS],
      { fence: true },
      engine
    );
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(STEPS);
    expect(world.deliveries).toHaveLength(1);
    // run_started, then per step one batch (step_created + step_started)
    // and one step_completed, then run_completed.
    expect(afterSetup(world).creates).toBe(1 + 2 * STEPS + 1);
    for (const started of eventsOf(world, 'step_started')) {
      expect(dataOf(started)).toMatchObject({
        attempt: 1,
        startReason: 'first',
      });
    }
  });

  it('writes the start on its own on a World without batch writes', async () => {
    const { world } = await setupOrchestratorRun(
      sequentialSteps,
      [STEPS],
      { fence: true, noBatch: true },
      engine
    );
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(STEPS);
    expect(afterSetup(world).creates).toBe(1 + 3 * STEPS + 1);
  });

  it('does not list the log per inline step', async () => {
    const { world } = await setupOrchestratorRun(
      sequentialSteps,
      [STEPS],
      { fence: true },
      engine
    );
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(STEPS);
    // The delivery's load (and the load after `run_started`); every inline
    // step's own writes come back on their responses.
    expect(afterSetup(world).lists).toBeLessThanOrEqual(2);
  });
});
