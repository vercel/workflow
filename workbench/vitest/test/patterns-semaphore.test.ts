import { afterAll, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  cancelCoordinator,
  lockHolder,
  readSemaphoreStats,
  resetSemaphoreStats,
  semaphoreHolder,
  semaphoreInRunFanout,
  semaphoreReleaseOnThrow,
} from '../workflows/drivers/semaphore-drivers.js';

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  fanout: `sem-fanout-${RUN}`,
  inRun: `sem-in-run-${RUN}`,
  throw: `sem-throw-${RUN}`,
  lock: `sem-lock-${RUN}`,
};

// Holders are separate runs, so the counters they share live in the step
// bundle's module scope. Reset before a fan-out, read after it settles.
async function resetStats() {
  const run = await start(resetSemaphoreStats, []);
  await run.returnValue;
}

async function readStats() {
  const run = await start(readSemaphoreStats, []);
  return run.returnValue;
}

describe('semaphore', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await cancelCoordinator(`semaphore:${key}`);
    }
  });

  it('bounds concurrency to maxConcurrent across concurrent runs', async () => {
    await resetStats();

    const holders = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        start(semaphoreHolder, [KEYS.fanout, 3, i])
      )
    );
    await Promise.all(holders.map((run) => run.returnValue));

    const stats = await readStats();

    expect(stats.order).toHaveLength(8);
    expect(stats.max).toBeGreaterThan(0);
    expect(stats.max).toBeLessThanOrEqual(3);
  });

  // Same bound, but the holders are concurrent calls inside ONE run. This is
  // the shape that trips replay divergence if withPermit() lets its hook and
  // retry timer be allocated in step-completion order instead of call order.
  it('bounds concurrency to maxConcurrent across concurrent calls in one run', async () => {
    const run = await start(semaphoreInRunFanout, [KEYS.inRun, 8, 3]);
    const result = await run.returnValue;

    expect(result.order).toHaveLength(8);
    expect(result.maxObserved).toBeGreaterThan(0);
    expect(result.maxObserved).toBeLessThanOrEqual(3);
  });

  it('releases the permit when the critical section throws', async () => {
    const run = await start(semaphoreReleaseOnThrow, [KEYS.throw]);
    const result = await run.returnValue;

    expect(result.results).toEqual(['threw', 'reacquired']);
  });

  it('withLock serializes critical sections (max concurrency 1)', async () => {
    await resetStats();

    const holders = await Promise.all([
      start(lockHolder, [KEYS.lock, 0]),
      start(lockHolder, [KEYS.lock, 1]),
    ]);
    await Promise.all(holders.map((run) => run.returnValue));

    const stats = await readStats();

    expect(stats.order).toHaveLength(2);
    expect(stats.max).toBe(1);
  });
});
