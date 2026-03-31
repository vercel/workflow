import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LimitDefinitionConflictError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { SPEC_VERSION_CURRENT, createLockCorrelationId } from '@workflow/world';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.mts';
import { createLocalWorld } from './index.js';
import { createLimits } from './limits.js';

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
  it('persists nextWaiter metadata and emits lock_waiter_queued on release', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
    const world = createLocalWorld({ dataDir: dir });
    world.registerHandler('__wkf_workflow_', async () =>
      Response.json({ ok: true })
    );

    try {
      const runA = (
        await world.events.create(null, {
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            deploymentId: 'deployment-123',
            workflowName: 'holder-a',
            input: [],
          },
        })
      ).run;
      const runB = (
        await world.events.create(null, {
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            deploymentId: 'deployment-123',
            workflowName: 'holder-b',
            input: [],
          },
        })
      ).run;
      if (!runA || !runB) {
        throw new Error('expected runs');
      }
      const correlationA = createLockCorrelationId(runA.runId, 0);
      const correlationB = createLockCorrelationId(runB.runId, 0);

      const first = await world.events.create(runA.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationA,
        eventData: {
          key: 'workflow:user:test',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });
      const second = await world.events.create(runB.runId, {
        eventType: 'lock_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationB,
        eventData: {
          key: 'workflow:user:test',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 10_000,
        },
      });

      expect(first.event?.eventType).toBe('lock_acquired');
      expect(second.event?.eventType).toBe('lock_created');

      const released = await world.events.create(runA.runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: correlationA,
      });

      expect(released.event?.eventType).toBe('lock_release');
      if (!released.event || released.event.eventType !== 'lock_release') {
        throw new Error('expected lock_release event');
      }
      expect(released.event.eventData?.nextWaiter).toMatchObject({
        runId: runB.runId,
        lockIndex: 0,
        lockCorrelationId: correlationB,
      });

      const correlated = await world.events.listByCorrelationId({
        correlationId: correlationB,
      });
      expect(
        correlated.data.some(
          (event) => event.eventType === 'lock_waiter_queued'
        )
      ).toBe(true);
    } finally {
      await world.close?.();
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
