import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LimitDefinitionConflictError } from '@workflow/errors';
import { describe, expect, it, vi } from 'vitest';
import { SPEC_VERSION_CURRENT, createLockCorrelationId } from '@workflow/world';
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

describe('local world limit retry timing', () => {
  it('persists promotedWaiters metadata and emits lock_waiter_queued for every promoted waiter', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const runs = createRunsStorage(dir);
    const queue = { queue: vi.fn().mockResolvedValue(undefined) };
    let limits = createLimits(dir, { storage: { runs } });
    const events = createEventsStorage(dir, undefined, {
      getLimits: () => limits,
      queue,
      runs,
    });

    try {
      const runA = await createRun(events, 'holder-a');
      const runB = await createRun(events, 'holder-b');
      const runC = await createRun(events, 'holder-c');
      const runD = await createRun(events, 'holder-d');

      for (const run of [runA, runB, runC, runD]) {
        await events.create(run.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
      }

      const correlationA = createLockCorrelationId(runA.runId, 0);
      const correlationB = createLockCorrelationId(runB.runId, 0);
      const correlationC = createLockCorrelationId(runC.runId, 0);
      const correlationD = createLockCorrelationId(runD.runId, 0);

      const first = await events.create(runA.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationA,
        eventData: {
          key: 'workflow:user:test',
          definition: { concurrency: { max: 2 } },
          leaseTtlMs: 10_000,
        },
      });
      const second = await events.create(runB.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationB,
        eventData: {
          key: 'workflow:user:test',
          definition: { concurrency: { max: 2 } },
          leaseTtlMs: 10_000,
        },
      });
      const third = await events.create(runC.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationC,
        eventData: {
          key: 'workflow:user:test',
          definition: { concurrency: { max: 2 } },
          leaseTtlMs: 10_000,
        },
      });
      const fourth = await events.create(runD.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationD,
        eventData: {
          key: 'workflow:user:test',
          definition: { concurrency: { max: 2 } },
          leaseTtlMs: 10_000,
        },
      });

      expect(first.event?.eventType).toBe('lock_acquired');
      expect(second.event?.eventType).toBe('lock_acquired');
      expect(third.event?.eventType).toBe('lock_created');
      expect(fourth.event?.eventType).toBe('lock_created');

      await events.create(runB.runId, {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { output: null },
      });

      const released = await events.create(runA.runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationA,
      });

      expect(released.event?.eventType).toBe('lock_release');
      if (!released.event || released.event.eventType !== 'lock_release') {
        throw new Error('expected lock_release event');
      }
      expect(released.event.eventData?.promotedWaiters).toEqual([
        expect.objectContaining({
          runId: runC.runId,
          lockIndex: 0,
          lockCorrelationId: correlationC,
        }),
        expect.objectContaining({
          runId: runD.runId,
          lockIndex: 0,
          lockCorrelationId: correlationD,
        }),
      ]);
      expect(queue.queue).toHaveBeenCalledTimes(2);

      for (const correlationId of [correlationC, correlationD]) {
        const correlated = await events.listByCorrelationId({
          correlationId,
        });
        expect(
          correlated.data.some(
            (event) => event.eventType === 'lock_waiter_queued'
          )
        ).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('compensates skipped or failed waiter wake-ups and recursively queues the next waiter', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const runs = createRunsStorage(dir);
    const queue = {
      queue: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('queue failed'))
        .mockResolvedValue(undefined),
    };
    const limits = createLimits(dir, { storage: { runs } });
    const events = createEventsStorage(dir, undefined, {
      getLimits: () => limits,
      queue,
      runs,
    });

    try {
      const holderRun = await createRun(events, 'holder-a');
      const terminalWaiterRun = await createRun(events, 'holder-b');
      const liveWaiterRun = await createRun(events, 'holder-c');

      for (const run of [holderRun, terminalWaiterRun, liveWaiterRun]) {
        await events.create(run.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
      }

      const holderCorrelation = createLockCorrelationId(holderRun.runId, 0);
      const terminalCorrelation = createLockCorrelationId(
        terminalWaiterRun.runId,
        0
      );
      const liveCorrelation = createLockCorrelationId(liveWaiterRun.runId, 0);

      await events.create(holderRun.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: holderCorrelation,
        eventData: {
          key: 'workflow:user:terminal-promoted',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });
      await events.create(terminalWaiterRun.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: terminalCorrelation,
        eventData: {
          key: 'workflow:user:terminal-promoted',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });
      await events.create(liveWaiterRun.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: liveCorrelation,
        eventData: {
          key: 'workflow:user:terminal-promoted',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });

      await events.create(terminalWaiterRun.runId, {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { output: null },
      });

      await events.create(holderRun.runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: holderCorrelation,
      });

      expect(queue.queue).toHaveBeenCalledTimes(1);
      expect(queue.queue).toHaveBeenCalledWith(
        '__wkf_workflow_holder-c',
        expect.objectContaining({
          runId: liveWaiterRun.runId,
          lockPreApproval: liveCorrelation,
        }),
        expect.objectContaining({
          idempotencyKey: expect.any(String),
        })
      );

      const terminalEvents = await events.listByCorrelationId({
        correlationId: terminalCorrelation,
      });
      expect(
        terminalEvents.data.some(
          (event) => event.eventType === 'lock_waiter_queued'
        )
      ).toBe(false);

      const liveEvents = await events.listByCorrelationId({
        correlationId: liveCorrelation,
      });
      expect(
        liveEvents.data.some(
          (event) => event.eventType === 'lock_waiter_queued'
        )
      ).toBe(true);
      const failedHolderRun = await createRun(events, 'holder-d');
      const failedFirstWaiterRun = await createRun(events, 'holder-e');
      const failedSecondWaiterRun = await createRun(events, 'holder-f');

      for (const run of [
        failedHolderRun,
        failedFirstWaiterRun,
        failedSecondWaiterRun,
      ]) {
        await events.create(run.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
      }

      const failedHolderCorrelation = createLockCorrelationId(
        failedHolderRun.runId,
        0
      );
      const failedFirstCorrelation = createLockCorrelationId(
        failedFirstWaiterRun.runId,
        0
      );
      const failedSecondCorrelation = createLockCorrelationId(
        failedSecondWaiterRun.runId,
        0
      );

      await events.create(failedHolderRun.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: failedHolderCorrelation,
        eventData: {
          key: 'workflow:user:queue-failure',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });
      await events.create(failedFirstWaiterRun.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: failedFirstCorrelation,
        eventData: {
          key: 'workflow:user:queue-failure',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });
      await events.create(failedSecondWaiterRun.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: failedSecondCorrelation,
        eventData: {
          key: 'workflow:user:queue-failure',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });

      await events.create(failedHolderRun.runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: failedHolderCorrelation,
      });

      expect(queue.queue).toHaveBeenCalledTimes(3);
      expect(queue.queue.mock.calls[1]?.[1]).toMatchObject({
        runId: failedFirstWaiterRun.runId,
        lockPreApproval: failedFirstCorrelation,
      });
      expect(queue.queue.mock.calls[2]?.[1]).toMatchObject({
        runId: failedSecondWaiterRun.runId,
        lockPreApproval: failedSecondCorrelation,
      });

      const firstEvents = await events.listByCorrelationId({
        correlationId: failedFirstCorrelation,
      });
      expect(
        firstEvents.data.some(
          (event) => event.eventType === 'lock_waiter_queued'
        )
      ).toBe(false);

      const secondEvents = await events.listByCorrelationId({
        correlationId: failedSecondCorrelation,
      });
      expect(
        secondEvents.data.some(
          (event) => event.eventType === 'lock_waiter_queued'
        )
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the same key is acquired with a conflicting definition', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const limits = createLimits(dir);

    try {
      await expect(
        limits.acquire({
          key: 'shared-key',
          runId: 'run-a',
          lockIndex: 0,
          definition: {
            concurrency: { max: 1 },
          },
          leaseTtlMs: 60_000,
        })
      ).resolves.toMatchObject({ status: 'acquired' });

      await expect(
        limits.acquire({
          key: 'shared-key',
          runId: 'run-b',
          lockIndex: 0,
          definition: {
            rate: { count: 1, periodMs: 5_000 },
          },
          leaseTtlMs: 60_000,
        })
      ).rejects.toBeInstanceOf(LimitDefinitionConflictError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows a key definition to be reseeded after the key fully drains', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const limits = createLimits(dir);

    try {
      await expect(
        limits.acquire({
          key: 'shared-key',
          runId: 'run-a',
          lockIndex: 0,
          definition: {
            concurrency: { max: 1 },
          },
          leaseTtlMs: 200,
        })
      ).resolves.toMatchObject({ status: 'acquired' });

      await new Promise((resolve) => setTimeout(resolve, 400));

      await expect(
        limits.acquire({
          key: 'shared-key',
          runId: 'run-b',
          lockIndex: 0,
          definition: {
            rate: { count: 1, periodMs: 5_000 },
          },
          leaseTtlMs: 200,
        })
      ).resolves.toMatchObject({ status: 'acquired' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the head waiter retryAfter for backlog-only waiters', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const limits = createLimits(dir);

    try {
      const key = 'shared-key';
      const periodMs = 5_000;

      const acquired = await limits.acquire({
        key,
        runId: 'run-a',
        lockIndex: 0,
        definition: {
          rate: { count: 1, periodMs },
        },
        leaseTtlMs: 10,
      });
      expect(acquired.status).toBe('acquired');

      await new Promise((resolve) => setTimeout(resolve, 25));

      const headWaiter = await limits.acquire({
        key,
        runId: 'run-b',
        lockIndex: 0,
        definition: {
          rate: { count: 1, periodMs },
        },
        leaseTtlMs: 10,
      });
      expect(headWaiter.status).toBe('blocked');
      if (headWaiter.status !== 'blocked') {
        throw new Error('expected blocked');
      }
      expect(headWaiter.retryAfterMs).toBeGreaterThan(0);

      const backlogOnlyWaiter = await limits.acquire({
        key,
        runId: 'run-c',
        lockIndex: 0,
        definition: {
          rate: { count: 1, periodMs },
        },
        leaseTtlMs: 10,
      });
      expect(backlogOnlyWaiter.status).toBe('blocked');
      if (backlogOnlyWaiter.status !== 'blocked') {
        throw new Error('expected blocked');
      }
      expect(backlogOnlyWaiter.retryAfterMs).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
