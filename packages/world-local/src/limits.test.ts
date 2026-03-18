import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createLocalWorld } from './index.js';
import { createLimits } from './limits.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-limits-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('local world limits', () => {
  it('exposes the required limits namespace', async () => {
    await withTempDir(async (dir) => {
      const world = createLocalWorld({ dataDir: dir });
      expect(world.limits).toBeDefined();
      expect(typeof world.limits.acquire).toBe('function');
      expect(typeof world.limits.release).toBe('function');
      expect(typeof world.limits.heartbeat).toBe('function');
      await world.close?.();
    });
  });

  it('enforces per-key concurrency limits', async () => {
    await withTempDir(async (dir) => {
      const limits = createLimits(dir);

      const first = await limits.acquire({
        key: 'step:db:cheap',
        holderId: 'holder-a',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });

      expect(first.status).toBe('acquired');
      if (first.status !== 'acquired') {
        throw new Error('expected first lease to be acquired');
      }

      const second = await limits.acquire({
        key: 'step:db:cheap',
        holderId: 'holder-b',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });

      expect(second).toMatchObject({
        status: 'blocked',
        reason: 'concurrency',
      });

      await limits.release({
        leaseId: first.lease.leaseId,
        key: first.lease.key,
        holderId: first.lease.holderId,
      });

      const third = await limits.acquire({
        key: 'step:db:cheap',
        holderId: 'holder-b',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });

      expect(third.status).toBe('acquired');
    });
  });

  it('returns a retry path when rate limits block acquisition', async () => {
    await withTempDir(async (dir) => {
      const limits = createLimits(dir);

      const first = await limits.acquire({
        key: 'step:provider:openai',
        holderId: 'holder-a',
        definition: { rate: { count: 1, periodMs: 100 } },
        leaseTtlMs: 1_000,
      });

      expect(first.status).toBe('acquired');
      if (first.status !== 'acquired') {
        throw new Error('expected first lease to be acquired');
      }

      await limits.release({
        leaseId: first.lease.leaseId,
        key: first.lease.key,
        holderId: first.lease.holderId,
      });

      const second = await limits.acquire({
        key: 'step:provider:openai',
        holderId: 'holder-b',
        definition: { rate: { count: 1, periodMs: 100 } },
        leaseTtlMs: 1_000,
      });

      expect(second.status).toBe('blocked');
      if (second.status !== 'blocked') {
        throw new Error('expected second acquire to be blocked');
      }
      expect(second.reason).toBe('rate');
      expect(second.retryAfterMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('restores capacity when a lease is released or expires', async () => {
    await withTempDir(async (dir) => {
      const limits = createLimits(dir);

      const first = await limits.acquire({
        key: 'workflow:user:123',
        holderId: 'holder-a',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 25,
      });

      expect(first.status).toBe('acquired');
      if (first.status !== 'acquired') {
        throw new Error('expected first lease to be acquired');
      }

      const heartbeat = await limits.heartbeat({
        leaseId: first.lease.leaseId,
        ttlMs: 50,
      });
      expect(heartbeat.expiresAt?.getTime()).toBeGreaterThan(
        first.lease.expiresAt?.getTime() ?? 0
      );

      await sleep(60);

      const second = await limits.acquire({
        key: 'workflow:user:123',
        holderId: 'holder-b',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });

      expect(second.status).toBe('acquired');
    });
  });
});
