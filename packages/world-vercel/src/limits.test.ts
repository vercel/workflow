import { describe, expect, it } from 'vitest';
import { LIMITS_NOT_IMPLEMENTED_MESSAGE } from '@workflow/world';
import { createVercelWorld } from './index.js';
import { createLimits } from './limits.js';

describe('vercel world limits', () => {
  it('exposes the required limits namespace', () => {
    const limits = createLimits();

    expect(limits).toMatchObject({
      acquire: expect.any(Function),
      release: expect.any(Function),
      heartbeat: expect.any(Function),
    });
  });

  it('keeps limits unimplemented until lock support exists', async () => {
    const world = createVercelWorld();

    await expect(
      world.limits.acquire({
        key: 'workflow:user:test',
        runId: 'wrun_test',
        lockIndex: 0,
        definition: { concurrency: { max: 1 } },
      })
    ).rejects.toThrow(LIMITS_NOT_IMPLEMENTED_MESSAGE);

    await expect(
      world.limits.release({
        leaseId: 'lease_test',
      })
    ).rejects.toThrow(LIMITS_NOT_IMPLEMENTED_MESSAGE);

    await expect(
      world.limits.heartbeat({
        leaseId: 'lease_test',
      })
    ).rejects.toThrow(LIMITS_NOT_IMPLEMENTED_MESSAGE);
  });
});
