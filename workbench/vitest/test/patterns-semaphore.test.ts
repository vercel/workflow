import { afterAll, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  cancelCoordinator,
  lockSerializes,
  semaphoreFanout,
  semaphoreReleaseOnThrow,
} from '../workflows/drivers/semaphore-drivers.js';

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  fanout: `sem-fanout-${RUN}`,
  throw: `sem-throw-${RUN}`,
  lock: `sem-lock-${RUN}`,
};

describe('semaphore', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await cancelCoordinator(`semaphore:${key}`);
    }
  });

  it('bounds concurrency to maxConcurrent across parallel holders', async () => {
    const run = await start(semaphoreFanout, [KEYS.fanout, 8, 3]);
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
    const run = await start(lockSerializes, [KEYS.lock]);
    const result = await run.returnValue;

    expect(result.maxObserved).toBe(1);
  });
});
