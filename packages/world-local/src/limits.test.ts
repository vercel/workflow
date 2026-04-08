import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { vi } from 'vitest';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.mts';
import { createLimitsEventsContractSuite } from '../../world-testing/src/limits-events-contract.mts';
import { createLocalWorld } from './index.js';
import { createLimits } from './limits.js';
import { createEventsStorage } from './storage/events-storage.js';
import { createRunsStorage } from './storage/runs-storage.js';

async function createRun(
  events: ReturnType<typeof createEventsStorage>,
  workflowName: string
) {
  const result = await events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'deployment-123',
      workflowName,
      input: [],
    },
  });
  if (!result.run) {
    throw new Error('expected run');
  }
  return result.run;
}

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
            leases?: { lockId: string }[];
            waiters?: { lockId: string }[];
            tokens?: { lockId: string }[];
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
        leaseHolderIds: keyState?.leases?.map((lease) => lease.lockId) ?? [],
        waiterHolderIds:
          keyState?.waiters?.map((waiter) => waiter.lockId) ?? [],
        tokenHolderIds: keyState?.tokens?.map((token) => token.lockId) ?? [],
      };
    },
    close: async () => {
      await world.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

createLimitsEventsContractSuite('local world limit events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
  const runs = createRunsStorage(dir);
  const queue = { queue: vi.fn().mockResolvedValue(undefined) };
  const limits = createLimits(dir, { storage: { runs } });
  const events = createEventsStorage(dir, undefined, {
    limits,
    queue,
    runs,
  });

  return {
    queue,
    prepareQueueFailure: () => {
      queue.queue
        .mockRejectedValueOnce(new Error('queue failed'))
        .mockResolvedValue(undefined);
    },
    createOwner: async (workflowName) => {
      const run = await createRun(events, workflowName);
      return {
        runId: run.runId,
        lockIndex: 0,
      };
    },
    startRun: async (runId) => {
      await events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
    },
    completeRun: async (runId) => {
      await events.create(runId, {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { output: null },
      });
    },
    createLock: async (
      runId,
      correlationId,
      key,
      leaseTtlMs,
      concurrencyMax
    ) => {
      return await events.create(runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId,
        eventData: {
          key,
          definition: {
            concurrency: { max: concurrencyMax },
          },
          leaseTtlMs,
        },
      });
    },
    releaseLock: async (runId, correlationId) => {
      return await events.create(runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId,
      });
    },
    listEvents: async (correlationId) => {
      return (await events.listByCorrelationId({ correlationId })).data;
    },
  };
});
