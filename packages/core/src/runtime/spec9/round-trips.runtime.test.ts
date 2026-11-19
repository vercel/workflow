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
import {
  getMaxInlineSteps,
  MAX_BATCH_EVENTS,
  MAX_IN_BAND_CREATION_BATCH_EVENTS,
} from '../constants.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// World round trips an orchestrator makes per inline step. On world-vercel
// each one is a network round trip on the step-to-step path, so these are
// latency budgets, not implementation details.

registerStepFunction('rt_inc', async (n: number) => n + 1);

const STEPS = 20;

const fanOut = `const inc = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("rt_inc");
  async function workflow(width) {
    const results = await Promise.all(
      Array.from({ length: width }, (_, i) => inc(i))
    );
    return results.reduce((sum, x) => sum + x, 0);
  }${registerWorkflow()}`;

/** `0 + 1 + ... + (width - 1)`, each incremented once. */
const fanOutResult = (width: number) => (width * (width + 1)) / 2;

/** Records the event type of every single (non-batch) `events.create`. */
function recordSingles() {
  const singles: string[] = [];
  return {
    singles,
    beforeCreate(
      data: { eventType: string },
      _params: unknown,
      source?: { batch: boolean }
    ) {
      if (!source?.batch) singles.push(data.eventType);
    },
  };
}

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
    // run_started, then per step its creation-bearing step_started and
    // its step_completed, then run_completed.
    expect(afterSetup(world).creates).toBe(1 + 2 * STEPS + 1);
    expect(eventsOf(world, 'step_created')).toEqual([]);
    for (const started of eventsOf(world, 'step_started')) {
      expect(dataOf(started)).toMatchObject({
        attempt: 1,
        inline: true,
      });
    }
  });

  it('writes the same two events per inline step on a World without batch writes', async () => {
    const { world } = await setupOrchestratorRun(
      sequentialSteps,
      [STEPS],
      { fence: true, noBatch: true },
      engine
    );
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(STEPS);
    expect(afterSetup(world).creates).toBe(1 + 2 * STEPS + 1);
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

  // A fan-out's background creations go out as creation batches of at most
  // MAX_IN_BAND_CREATION_BATCH_EVENTS, not one write each: an in-band writer
  // sends one write at a time, so each write is a round trip in front of
  // every branch behind it.
  describe.each([
    MAX_BATCH_EVENTS,
    MAX_IN_BAND_CREATION_BATCH_EVENTS,
    2 * MAX_IN_BAND_CREATION_BATCH_EVENTS + MAX_BATCH_EVENTS,
  ])('a %i-wide fan-out', (width) => {
    it('without inline steps: run_started, then one write per creation batch', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      const writes = recordSingles();
      const { world } = await setupOrchestratorRun(
        fanOut,
        [width],
        { fence: true, beforeCreate: writes.beforeCreate },
        engine
      );
      const before = world.createCalls;
      await world.deliver(world.held[0]!);
      const firstDelivery = world.createCalls - before;

      const creationBatches = Math.ceil(
        width / MAX_IN_BAND_CREATION_BATCH_EVENTS
      );
      expect(writes.singles).toEqual(['run_started']);
      expect(world.batches).toHaveLength(creationBatches);
      expect(firstDelivery).toBe(1 + creationBatches);
      expect(world.batches.flat()).toEqual(
        Array.from({ length: width }, () => 'step_created')
      );

      await world.runUntilIdle(4 * width);
      expect(await runResult(world)).toBe(fanOutResult(width));
      expect(eventsOf(world, 'step_created')).toHaveLength(width);
    });

    it('with inline steps: the background creations still go out in batches', async () => {
      const writes = recordSingles();
      const { world } = await setupOrchestratorRun(
        fanOut,
        [width],
        { fence: true, beforeCreate: writes.beforeCreate },
        engine
      );
      await world.deliver(world.held[0]!);

      const inline = Math.min(getMaxInlineSteps(), width);
      const background = width - inline;
      const creations = world.batches
        .flat()
        .filter((type) => type === 'step_created');
      expect(creations).toHaveLength(background);
      expect(writes.singles.filter((type) => type === 'step_created')).toEqual(
        []
      );
      expect(
        world.batches.filter((batch) => batch.includes('step_created'))
      ).toHaveLength(
        Math.ceil(
          (engine === 'node' ? width : background) /
            MAX_IN_BAND_CREATION_BATCH_EVENTS
        )
      );

      await world.runUntilIdle(4 * width);
      expect(await runResult(world)).toBe(fanOutResult(width));
    });
  });
});
