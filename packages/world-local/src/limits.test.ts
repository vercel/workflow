import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.js';
import { createLocalWorld } from './index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

createLimitsContractSuite('local world limits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
  const world = createLocalWorld({ dataDir: dir });
  world.registerHandler('__wkf_step_', async () => Response.json({ ok: true }));
  world.registerHandler('__wkf_workflow_', async () =>
    Response.json({ ok: true })
  );

  return {
    limits: world.limits,
    storage: world,
    close: async () => {
      await world.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
});
