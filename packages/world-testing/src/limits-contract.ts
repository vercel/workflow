import { setTimeout as sleep } from 'node:timers/promises';
import type { Limits } from '@workflow/world';
import { describe, expect, it } from 'vitest';

export interface LimitsHarness {
  limits: Limits;
  close?: () => Promise<void>;
}

export function createLimitsContractSuite(
  name: string,
  createHarness: () => Promise<LimitsHarness>
) {
  describe(name, () => {
    it('enforces per-key concurrency limits', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'step:db:cheap',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'step:db:cheap',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(second).toMatchObject({
          status: 'blocked',
          reason: 'concurrency',
        });

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          key: first.lease.key,
          holderId: first.lease.holderId,
        });

        const third = await harness.limits.acquire({
          key: 'step:db:cheap',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('returns a retry path when rate limits block acquisition', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'step:provider:openai',
          holderId: 'holder-a',
          definition: { rate: { count: 1, periodMs: 100 } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          key: first.lease.key,
          holderId: first.lease.holderId,
        });

        const second = await harness.limits.acquire({
          key: 'step:provider:openai',
          holderId: 'holder-b',
          definition: { rate: { count: 1, periodMs: 100 } },
          leaseTtlMs: 1_000,
        });
        expect(second.status).toBe('blocked');
        if (second.status !== 'blocked') throw new Error('expected blocked');
        expect(second.reason).toBe('rate');
        expect(second.retryAfterMs).toBeGreaterThanOrEqual(0);
      } finally {
        await harness.close?.();
      }
    });

    it('returns a combined blocked reason when both limits are saturated', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'step:mixed',
          holderId: 'holder-a',
          definition: {
            concurrency: { max: 1 },
            rate: { count: 1, periodMs: 1_000 },
          },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'step:mixed',
          holderId: 'holder-b',
          definition: {
            concurrency: { max: 1 },
            rate: { count: 1, periodMs: 1_000 },
          },
          leaseTtlMs: 1_000,
        });
        expect(second).toMatchObject({
          status: 'blocked',
          reason: 'concurrency_and_rate',
        });
      } finally {
        await harness.close?.();
      }
    });

    it('restores capacity when a lease is released or expires', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'workflow:user:123',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 100,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const heartbeat = await harness.limits.heartbeat({
          leaseId: first.lease.leaseId,
          ttlMs: 200,
        });
        expect(heartbeat.expiresAt?.getTime()).toBeGreaterThan(
          first.lease.expiresAt?.getTime() ?? 0
        );

        await sleep(250);

        const second = await harness.limits.acquire({
          key: 'workflow:user:123',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(second.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('reuses an existing lease for the same holder', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'workflow:user:reacquire',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'workflow:user:reacquire',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(second).toMatchObject({
          status: 'acquired',
          lease: {
            leaseId: first.lease.leaseId,
            holderId: first.lease.holderId,
          },
        });
      } finally {
        await harness.close?.();
      }
    });
  });
}
