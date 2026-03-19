import { WorkflowWorldError } from '@workflow/errors';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.js';
import { describe, expect, it } from 'vitest';
import { createLocalWorld } from './index.js';
import { createLimits } from './limits.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

createLimitsContractSuite('local world limits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
  const world = createLocalWorld({ dataDir: dir });

  return {
    limits: createLimits(dir),
    close: async () => {
      await world.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe('local limits', () => {
  it('throws WorkflowWorldError when heartbeating a missing lease', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const limits = createLimits(dir);

    try {
      await expect(
        limits.heartbeat({
          leaseId: 'lmt_missing',
        })
      ).rejects.toBeInstanceOf(WorkflowWorldError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
