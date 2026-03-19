import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.js';
import { createLocalWorld } from './index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    inspectKeyState: async (key) => {
      const statePath = path.join(dir, 'limits', 'state.json');
      let raw: {
        keys?: Record<
          string,
          {
            leases?: { holderId: string }[];
            waiters?: { holderId: string }[];
            tokens?: { holderId: string }[];
          }
        >;
      };
      try {
        raw = JSON.parse(await readFile(statePath, 'utf8'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return {
            leaseHolderIds: [],
            waiterHolderIds: [],
            tokenHolderIds: [],
          };
        }
        throw error;
      }

      const keyState = raw.keys?.[key];
      return {
        leaseHolderIds: keyState?.leases?.map((lease) => lease.holderId) ?? [],
        waiterHolderIds:
          keyState?.waiters?.map((waiter) => waiter.holderId) ?? [],
        tokenHolderIds: keyState?.tokens?.map((token) => token.holderId) ?? [],
      };
    },
    close: async () => {
      await world.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
});
