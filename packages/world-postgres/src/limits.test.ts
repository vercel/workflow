import { asc, eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.js';
import * as Schema from './drizzle/schema.js';
import { createLimits } from './limits.js';

if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let db: Awaited<
    ReturnType<typeof import('../test/test-db.js').createPostgresTestDb>
  >;

  beforeAll(async () => {
    const { createPostgresTestDb } = await import('../test/test-db.js');
    db = await createPostgresTestDb();
  }, 120_000);

  beforeEach(async () => {
    await db.truncateLimits();
  });

  afterAll(async () => {
    await db.close();
  });

  createLimitsContractSuite('postgres world limits', async () => {
    return {
      limits: createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      ),
    };
  });

  describe('postgres waiter promotion', () => {
    it('serializes concurrent acquires for the same key', async () => {
      const limits = createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      );

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          limits.acquire({
            key: 'workflow:user:concurrent',
            holderId: `holder-${index}`,
            definition: { concurrency: { max: 1 } },
            leaseTtlMs: 1_000,
          })
        )
      );

      const acquired = results.filter((result) => result.status === 'acquired');
      const blocked = results.filter((result) => result.status === 'blocked');

      expect(acquired).toHaveLength(1);
      expect(blocked).toHaveLength(11);

      const leases = await db.drizzle
        .select({ holderId: Schema.limitLeases.holderId })
        .from(Schema.limitLeases)
        .where(eq(Schema.limitLeases.limitKey, 'workflow:user:concurrent'));
      const waiters = await db.drizzle
        .select({ holderId: Schema.limitWaiters.holderId })
        .from(Schema.limitWaiters)
        .where(eq(Schema.limitWaiters.limitKey, 'workflow:user:concurrent'));

      expect(leases).toHaveLength(1);
      expect(waiters).toHaveLength(11);
    });

    it('promotes the earliest waiter on release', async () => {
      const limits = createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      );

      const first = await limits.acquire({
        key: 'workflow:user:ordered',
        holderId: 'holder-a',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });
      expect(first.status).toBe('acquired');
      if (first.status !== 'acquired') throw new Error('expected acquisition');

      const second = await limits.acquire({
        key: 'workflow:user:ordered',
        holderId: 'holder-b',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });
      const third = await limits.acquire({
        key: 'workflow:user:ordered',
        holderId: 'holder-c',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });

      expect(second.status).toBe('blocked');
      expect(third.status).toBe('blocked');

      await limits.release({
        leaseId: first.lease.leaseId,
        holderId: first.lease.holderId,
        key: first.lease.key,
      });

      const leases = await db.drizzle
        .select({ holderId: Schema.limitLeases.holderId })
        .from(Schema.limitLeases)
        .where(eq(Schema.limitLeases.limitKey, first.lease.key))
        .orderBy(
          asc(Schema.limitLeases.acquiredAt),
          asc(Schema.limitLeases.leaseId)
        );
      const waiters = await db.drizzle
        .select({ holderId: Schema.limitWaiters.holderId })
        .from(Schema.limitWaiters)
        .where(eq(Schema.limitWaiters.limitKey, first.lease.key))
        .orderBy(
          asc(Schema.limitWaiters.createdAt),
          asc(Schema.limitWaiters.waiterId)
        );

      expect(leases).toEqual([{ holderId: 'holder-b' }]);
      expect(waiters).toEqual([{ holderId: 'holder-c' }]);

      const stillWaiting = await limits.acquire({
        key: 'workflow:user:ordered',
        holderId: 'holder-c',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      });
      expect(stillWaiting.status).toBe('blocked');
    });
  });
}
