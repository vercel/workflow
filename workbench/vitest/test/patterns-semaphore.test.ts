import { afterAll, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import {
  cancelCoordinator,
  lockHolder,
  longHolder,
  readSemaphoreStats,
  resetSemaphoreStats,
  semaphoreHolder,
  semaphoreInRunFanout,
  semaphoreReleaseOnThrow,
  spuriousRelease,
} from '../workflows/drivers/semaphore-drivers.js';

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  fanout: `sem-fanout-${RUN}`,
  inRun: `sem-in-run-${RUN}`,
  throw: `sem-throw-${RUN}`,
  lock: `sem-lock-${RUN}`,
  dupRelease: `sem-dup-release-${RUN}`,
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

  // Event delivery is at-least-once: a release that actually landed can look
  // like a failure to its sender and be re-sent. If the coordinator applied
  // both copies it would hand back capacity nobody gave up, and an extra
  // holder would slip into the critical section. Releases are keyed by grant
  // token and the coordinator only credits tokens it currently has out, so a
  // release it can't match is a no-op. An unknown token exercises exactly
  // that path, deterministically.
  it('ignores a release it never granted instead of freeing capacity', async () => {
    await resetStats();
    const key = KEYS.dupRelease;

    // Occupy the single permit for 4s.
    const holder = await start(longHolder, [key, 0, 4000]);
    await vi.waitFor(
      async () => {
        expect((await readStats()).order).toHaveLength(1);
      },
      { timeout: 15_000, interval: 100 }
    );

    // Free capacity that was never taken — then try to use it.
    await (await start(spuriousRelease, [key])).returnValue;
    const second = await start(longHolder, [key, 1, 10]);

    // Well inside the first holder's 4s hold: long enough for the second
    // holder's acquire to reach the coordinator and (buggily) be granted.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await readStats()).max).toBe(1);

    await Promise.all([holder.returnValue, second.returnValue]);
    const stats = await readStats();
    expect(stats.order).toEqual([0, 1]);
    expect(stats.max).toBe(1);
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
