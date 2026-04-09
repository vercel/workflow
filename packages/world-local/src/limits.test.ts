import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.mts';
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

async function createLocalEventsHarness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
  const runs = createRunsStorage(dir);
  const queue = { queue: vi.fn().mockResolvedValue(undefined) };
  const limits = createLimits(dir, { storage: { runs } });
  const events = createEventsStorage(dir, undefined, {
    limits,
    queue,
    runs,
  });

  const createOwner = async (workflowName: string) => {
    const run = await createRun(events, workflowName);
    return {
      runId: run.runId,
      lockIndex: 0,
    };
  };

  return {
    close: async () => {
      await rm(dir, { recursive: true, force: true });
    },
    queue,
    prepareQueueFailure: () => {
      queue.queue
        .mockRejectedValueOnce(new Error('queue failed'))
        .mockResolvedValue(undefined);
    },
    createOwner,
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
  };
}

describe('local world limit events', () => {
  it('persists promotedWaiters metadata and queues every promoted waiter', async () => {
    const harness = await createLocalEventsHarness();
    try {
      const ownerA = await harness.createOwner('holder-a');
      const ownerB = await harness.createOwner('holder-b');
      const ownerC = await harness.createOwner('holder-c');
      const ownerD = await harness.createOwner('holder-d');
      const correlationA = `wflock_${ownerA.runId}:${ownerA.lockIndex}`;
      const correlationB = `wflock_${ownerB.runId}:${ownerB.lockIndex}`;
      const correlationC = `wflock_${ownerC.runId}:${ownerC.lockIndex}`;
      const correlationD = `wflock_${ownerD.runId}:${ownerD.lockIndex}`;

      for (const owner of [ownerA, ownerB, ownerC, ownerD]) {
        await harness.startRun(owner.runId);
      }

      expect(
        (
          await harness.createLock(
            ownerA.runId,
            correlationA,
            'workflow:user:test',
            30_000,
            2
          )
        ).event?.eventType
      ).toBe('lock_acquired');
      expect(
        (
          await harness.createLock(
            ownerB.runId,
            correlationB,
            'workflow:user:test',
            30_000,
            2
          )
        ).event?.eventType
      ).toBe('lock_acquired');
      expect(
        (
          await harness.createLock(
            ownerC.runId,
            correlationC,
            'workflow:user:test',
            30_000,
            2
          )
        ).event?.eventType
      ).toBe('lock_created');
      expect(
        (
          await harness.createLock(
            ownerD.runId,
            correlationD,
            'workflow:user:test',
            30_000,
            2
          )
        ).event?.eventType
      ).toBe('lock_created');

      await harness.completeRun(ownerB.runId);

      const released = await harness.releaseLock(ownerA.runId, correlationA);
      expect(released.event?.eventType).toBe('lock_release');
      expect(released.event?.eventData?.promotedWaiters).toEqual([
        expect.objectContaining({
          runId: ownerC.runId,
          lockIndex: ownerC.lockIndex,
          lockCorrelationId: correlationC,
        }),
        expect.objectContaining({
          runId: ownerD.runId,
          lockIndex: ownerD.lockIndex,
          lockCorrelationId: correlationD,
        }),
      ]);
      expect(harness.queue.queue).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it('compensates skipped or failed waiter wake-ups and recursively queues the next waiter', async () => {
    const harness = await createLocalEventsHarness();
    try {
      const holder = await harness.createOwner('holder-a');
      const terminalWaiter = await harness.createOwner('holder-b');
      const liveWaiter = await harness.createOwner('holder-c');
      const holderCorrelation = `wflock_${holder.runId}:${holder.lockIndex}`;
      const terminalCorrelation = `wflock_${terminalWaiter.runId}:${terminalWaiter.lockIndex}`;
      const liveCorrelation = `wflock_${liveWaiter.runId}:${liveWaiter.lockIndex}`;

      for (const owner of [holder, terminalWaiter, liveWaiter]) {
        await harness.startRun(owner.runId);
      }

      await harness.createLock(
        holder.runId,
        holderCorrelation,
        'workflow:user:terminal-promoted',
        30_000,
        1
      );
      await harness.createLock(
        terminalWaiter.runId,
        terminalCorrelation,
        'workflow:user:terminal-promoted',
        30_000,
        1
      );
      await harness.createLock(
        liveWaiter.runId,
        liveCorrelation,
        'workflow:user:terminal-promoted',
        30_000,
        1
      );

      await harness.completeRun(terminalWaiter.runId);
      await harness.releaseLock(holder.runId, holderCorrelation);

      expect(harness.queue.queue).toHaveBeenCalledTimes(1);
      expect(harness.queue.queue.mock.calls[0]?.[1]).toMatchObject({
        runId: liveWaiter.runId,
        lockPreApproval: liveCorrelation,
      });

      const failedHolder = await harness.createOwner('holder-d');
      const failedFirstWaiter = await harness.createOwner('holder-e');
      const failedSecondWaiter = await harness.createOwner('holder-f');
      const failedHolderCorrelation = `wflock_${failedHolder.runId}:${failedHolder.lockIndex}`;
      const failedFirstCorrelation = `wflock_${failedFirstWaiter.runId}:${failedFirstWaiter.lockIndex}`;
      const failedSecondCorrelation = `wflock_${failedSecondWaiter.runId}:${failedSecondWaiter.lockIndex}`;

      harness.prepareQueueFailure();

      for (const owner of [
        failedHolder,
        failedFirstWaiter,
        failedSecondWaiter,
      ]) {
        await harness.startRun(owner.runId);
      }

      await harness.createLock(
        failedHolder.runId,
        failedHolderCorrelation,
        'workflow:user:queue-failure',
        30_000,
        1
      );
      await harness.createLock(
        failedFirstWaiter.runId,
        failedFirstCorrelation,
        'workflow:user:queue-failure',
        30_000,
        1
      );
      await harness.createLock(
        failedSecondWaiter.runId,
        failedSecondCorrelation,
        'workflow:user:queue-failure',
        30_000,
        1
      );

      await harness.releaseLock(failedHolder.runId, failedHolderCorrelation);

      expect(harness.queue.queue).toHaveBeenCalledTimes(3);
      expect(harness.queue.queue.mock.calls[1]?.[1]).toMatchObject({
        runId: failedFirstWaiter.runId,
        lockPreApproval: failedFirstCorrelation,
      });
      expect(harness.queue.queue.mock.calls[2]?.[1]).toMatchObject({
        runId: failedSecondWaiter.runId,
        lockPreApproval: failedSecondCorrelation,
      });
    } finally {
      await harness.close();
    }
  });
});
