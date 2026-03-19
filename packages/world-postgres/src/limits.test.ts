import { asc, eq } from 'drizzle-orm';
import { WorkflowWorldError } from '@workflow/errors';
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
    it('throws WorkflowWorldError when heartbeating a missing lease', async () => {
      const limits = createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      );

      await expect(
        limits.heartbeat({
          leaseId: 'lmt_missing',
        })
      ).rejects.toBeInstanceOf(WorkflowWorldError);
    });

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

    it('skips cancelled workflow waiters before promotion', async () => {
      const limits = createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      );

      await db.drizzle.insert(Schema.runs).values([
        {
          runId: 'wrun_dead_workflow',
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          status: 'cancelled',
        },
      ]);

      const first = await limits.acquire({
        key: 'workflow:user:skip-dead-workflow',
        holderId: 'holder-a',
        definition: {
          concurrency: { max: 1 },
          rate: { count: 2, periodMs: 5_000 },
        },
        leaseTtlMs: 5_000,
      });
      expect(first.status).toBe('acquired');
      if (first.status !== 'acquired') throw new Error('expected acquisition');

      await limits.acquire({
        key: 'workflow:user:skip-dead-workflow',
        holderId: 'wflock_wrun_dead_workflow:limitwait_dead',
        definition: {
          concurrency: { max: 1 },
          rate: { count: 2, periodMs: 5_000 },
        },
        leaseTtlMs: 5_000,
      });
      await limits.acquire({
        key: 'workflow:user:skip-dead-workflow',
        holderId: 'holder-live',
        definition: {
          concurrency: { max: 1 },
          rate: { count: 2, periodMs: 5_000 },
        },
        leaseTtlMs: 5_000,
      });

      await limits.release({
        leaseId: first.lease.leaseId,
        holderId: first.lease.holderId,
        key: first.lease.key,
      });

      const leases = await db.drizzle
        .select({ holderId: Schema.limitLeases.holderId })
        .from(Schema.limitLeases)
        .where(eq(Schema.limitLeases.limitKey, first.lease.key))
        .orderBy(asc(Schema.limitLeases.acquiredAt));
      const tokens = await db.drizzle
        .select({ holderId: Schema.limitTokens.holderId })
        .from(Schema.limitTokens)
        .where(eq(Schema.limitTokens.limitKey, first.lease.key))
        .orderBy(asc(Schema.limitTokens.acquiredAt));
      const waiters = await db.drizzle
        .select({ holderId: Schema.limitWaiters.holderId })
        .from(Schema.limitWaiters)
        .where(eq(Schema.limitWaiters.limitKey, first.lease.key))
        .orderBy(asc(Schema.limitWaiters.createdAt));

      expect(leases).toEqual([{ holderId: 'holder-live' }]);
      expect(tokens).toEqual([
        { holderId: first.lease.holderId },
        { holderId: 'holder-live' },
      ]);
      expect(waiters).toEqual([]);
    });

    it('skips failed step waiters before promotion', async () => {
      const limits = createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      );

      await db.drizzle.insert(Schema.runs).values([
        {
          runId: 'wrun_dead_step',
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          status: 'running',
          startedAt: new Date(),
        },
        {
          runId: 'wrun_live_step',
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          status: 'running',
          startedAt: new Date(),
        },
      ]);
      await db.drizzle.insert(Schema.steps).values([
        {
          runId: 'wrun_dead_step',
          stepId: 'step_dead',
          stepName: 'test-step',
          status: 'failed',
          attempt: 1,
        },
        {
          runId: 'wrun_live_step',
          stepId: 'step_live',
          stepName: 'test-step',
          status: 'pending',
          attempt: 0,
        },
      ]);

      const first = await limits.acquire({
        key: 'workflow:user:skip-dead-step',
        holderId: 'holder-a',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 5_000,
      });
      expect(first.status).toBe('acquired');
      if (first.status !== 'acquired') throw new Error('expected acquisition');

      await limits.acquire({
        key: 'workflow:user:skip-dead-step',
        holderId: 'stplock_wrun_dead_step:step_dead:0',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 5_000,
      });
      await limits.acquire({
        key: 'workflow:user:skip-dead-step',
        holderId: 'holder-live',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 5_000,
      });

      await limits.release({
        leaseId: first.lease.leaseId,
        holderId: first.lease.holderId,
        key: first.lease.key,
      });

      const leases = await db.drizzle
        .select({ holderId: Schema.limitLeases.holderId })
        .from(Schema.limitLeases)
        .where(eq(Schema.limitLeases.limitKey, first.lease.key))
        .orderBy(asc(Schema.limitLeases.acquiredAt));
      const waiters = await db.drizzle
        .select({ holderId: Schema.limitWaiters.holderId })
        .from(Schema.limitWaiters)
        .where(eq(Schema.limitWaiters.limitKey, first.lease.key))
        .orderBy(asc(Schema.limitWaiters.createdAt));

      expect(leases).toEqual([{ holderId: 'holder-live' }]);
      expect(waiters).toEqual([]);
    });
  });
}
