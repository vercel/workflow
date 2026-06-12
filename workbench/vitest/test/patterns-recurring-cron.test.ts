import { waitForSleep } from '@workflow/vitest';
import { afterAll, describe, expect, it } from 'vitest';
import type { Run } from 'workflow/api';
import { getHookByToken, getRun, start } from 'workflow/api';
import { readCronTicks } from '../workflows/drivers/recurring-cron-drivers.js';
import {
  recurringCron,
  stopCron,
} from '../workflows/patterns/recurring-cron.js';

// Mirrors the canonical constants (never shrunk for testability — sleeps
// are force-woken instead).
const INTERVAL_MS = 60 * 60 * 1000;
const ITERATIONS_PER_RUN = 24;

// Unique names per vitest invocation — the local world persists across runs.
const RUN = Date.now().toString(36);

type Tick = { iteration: number; dueAt: number };

async function readTicks(name: string): Promise<Tick[]> {
  // Under heavy load the local world can transiently report a freshly
  // started run as not-found when returnValue polls immediately after
  // start(). The read is idempotent, so just retry with a fresh run.
  for (let attempt = 0; ; attempt++) {
    try {
      const run = await start(readCronTicks, [name]);
      return await run.returnValue;
    } catch (error) {
      if (attempt < 3 && String(error).includes('not found')) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Drive the cron run by force-waking its pending sleeps until the demo job
 * has recorded `target` ticks. Wakes are only issued while below the
 * target, and each wake is followed by waiting for the tick count to
 * advance, so the loop can never overshoot.
 */
async function driveTicks(
  run: Run<any>,
  name: string,
  target: number
): Promise<Tick[]> {
  const deadline = Date.now() + 90_000;
  let ticks = await readTicks(name);
  while (ticks.length < target) {
    if (Date.now() > deadline) {
      throw new Error(
        `driveTicks timed out at ${ticks.length}/${target} ticks for "${name}"`
      );
    }
    const sleepId = await waitForSleep(run, { timeout: 15_000 });
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const before = ticks.length;
    while (ticks.length <= before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ticks = await readTicks(name);
    }
  }
  return ticks;
}

describe('recurring-cron', () => {
  const runIds: string[] = [];

  afterAll(async () => {
    // Don't leak live cron loops into the next suite.
    for (const runId of runIds) {
      await getRun(runId)
        .cancel()
        .catch(() => {});
    }
  });

  it('ticks advance with drift-corrected due times and stop cleanly', async () => {
    const name = `cron-${RUN}`;
    // First tick due slightly in the past → fires immediately; subsequent
    // due times are real future timestamps whose sleeps get force-woken.
    const t0 = Date.now() - 1_000;
    const run = await start(recurringCron, [
      name,
      { iteration: 0, nextDueAt: t0 },
    ]);
    runIds.push(run.runId);

    const ticks = await driveTicks(run, name, 3);

    // Drift correction: each tick anchored exactly INTERVAL_MS after the
    // previous DUE time (never on "now").
    expect(ticks).toEqual([
      { iteration: 0, dueAt: t0 },
      { iteration: 1, dueAt: t0 + INTERVAL_MS },
      { iteration: 2, dueAt: t0 + 2 * INTERVAL_MS },
    ]);

    // Tick 3 is now sleeping until its (future) due time — stop the
    // schedule cleanly between ticks via the generation's stop token.
    await waitForSleep(run);
    await stopCron.resume(`cron:${name}:0`, { reason: 'test done' });

    const result = await run.returnValue;
    expect(result).toEqual({ name, stoppedAt: 3 });

    // No further ticks ran after the stop.
    expect(await readTicks(name)).toHaveLength(3);
  });

  it(
    'continues-as-new after a full generation and the successor resumes the count',
    { timeout: 120_000 },
    async () => {
      const name = `cron-gen-${RUN}`;
      const t0 = Date.now() - 1_000;
      const run = await start(recurringCron, [
        name,
        { iteration: 0, nextDueAt: t0 },
      ]);
      runIds.push(run.runId);

      const ticks = await driveTicks(run, name, ITERATIONS_PER_RUN);

      // Generation 1 hands off to a fresh run and reports where it stopped.
      const result = await run.returnValue;
      expect(result).toEqual({ name, continuedAt: ITERATIONS_PER_RUN });

      // Every tick in the generation advanced by exactly INTERVAL_MS.
      expect(ticks.map((tick) => tick.iteration)).toEqual(
        Array.from({ length: ITERATIONS_PER_RUN }, (_, i) => i)
      );
      for (const tick of ticks) {
        expect(tick.dueAt).toBe(t0 + tick.iteration * INTERVAL_MS);
      }

      // The successor registers a NEW stop hook keyed by its generation
      // start (iteration 24) — find it and stop it cleanly.
      const successorToken = `cron:${name}:${ITERATIONS_PER_RUN}`;
      let successor: { runId: string } | null = null;
      const deadline = Date.now() + 15_000;
      while (!successor && Date.now() < deadline) {
        successor = await getHookByToken(successorToken).catch(() => null);
        if (!successor) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!successor) {
        throw new Error('successor generation never registered its stop hook');
      }
      expect(successor.runId).not.toBe(run.runId);
      runIds.push(successor.runId);

      await stopCron.resume(successorToken, { reason: 'test done' });
      const successorResult = await getRun(successor.runId).returnValue;
      expect(successorResult).toEqual({
        name,
        stoppedAt: ITERATIONS_PER_RUN,
      });
    }
  );
});
