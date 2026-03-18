import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.js';
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
