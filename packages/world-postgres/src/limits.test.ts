import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { LimitDefinitionConflictError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, createLockCorrelationId } from '@workflow/world';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.js';
import { createLimits } from './limits.js';
import {
  createEventsStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createQueue } from './queue.js';

if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let db: Awaited<
    ReturnType<typeof import('../test/test-db.js').createPostgresTestDb>
  >;

  beforeAll(async () => {
    const { createPostgresTestDb } = await import('../test/test-db.js');
    db = await createPostgresTestDb();
    const queue = createQueue(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.sql
    );
    await queue.start();
    await queue.close();
  }, 120_000);

  beforeEach(async () => {
    await db.truncateLimits();
  });

  async function createLockOwner(workflowName: string, lockIndex = 0) {
    const events = createEventsStorage(db.drizzle);
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
    return {
      runId: result.run.runId,
      lockIndex,
    };
  }

  afterAll(async () => {
    await db?.close();
  });

  createLimitsContractSuite('postgres world limits', async () => {
    return {
      limits: createLimits(
        { connectionString: db.connectionString, queueConcurrency: 1 },
        db.drizzle
      ),
      storage: {
        runs: createRunsStorage(db.drizzle),
        steps: createStepsStorage(db.drizzle),
        events: createEventsStorage(db.drizzle),
      },
      inspectKeyState: async (key) => {
        const [leases, waiters, tokens] = await Promise.all([
          db.sql<{ lockId: string }[]>`
            select holder_id as "lockId"
            from workflow.workflow_limit_leases
            where limit_key = ${key}
            order by holder_id asc
          `,
          db.sql<{ lockId: string }[]>`
            select holder_id as "lockId"
            from workflow.workflow_limit_waiters
            where limit_key = ${key}
            order by created_at asc, holder_id asc
          `,
          db.sql<{ lockId: string }[]>`
            select holder_id as "lockId"
            from workflow.workflow_rate_limit_tokens
            where limit_key = ${key}
            order by acquired_at asc, holder_id asc
          `,
        ]);

        return {
          leaseHolderIds: leases.map((row) => row.lockId),
          waiterHolderIds: waiters.map((row) => row.lockId),
          tokenHolderIds: tokens.map((row) => row.lockId),
        };
      },
    };
  });

  test('uses the head waiter retryAfter for waiters queued behind a long rate window', async () => {
    const limits = createLimits(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.drizzle
    );
    const key = 'workflow:fifo:head-waiter-rate';
    const periodMs = 60_000;
    const ownerA = await createLockOwner('holder-a');
    const ownerB = await createLockOwner('holder-b');
    const ownerC = await createLockOwner('holder-c');

    const first = await limits.acquire({
      key,
      runId: ownerA.runId,
      lockIndex: ownerA.lockIndex,
      definition: { rate: { count: 1, periodMs } },
      leaseTtlMs: 1_000,
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected acquisition');

    await limits.release({
      leaseId: first.lease.leaseId,
      key: first.lease.key,
      lockId: first.lease.lockId,
    });

    const headWaiter = await limits.acquire({
      key,
      runId: ownerB.runId,
      lockIndex: ownerB.lockIndex,
      definition: { rate: { count: 1, periodMs } },
      leaseTtlMs: 1_000,
    });
    expect(headWaiter.status).toBe('blocked');
    if (headWaiter.status !== 'blocked') throw new Error('expected blocked');

    const behindHead = await limits.acquire({
      key,
      runId: ownerC.runId,
      lockIndex: ownerC.lockIndex,
      definition: { rate: { count: 1, periodMs } },
      leaseTtlMs: 1_000,
    });
    expect(behindHead.status).toBe('blocked');
    if (behindHead.status !== 'blocked') throw new Error('expected blocked');
    expect(behindHead.retryAfterMs).toBeGreaterThan(5_000);

    const existingWaiterRetry = await limits.acquire({
      key,
      runId: ownerC.runId,
      lockIndex: ownerC.lockIndex,
      definition: { rate: { count: 1, periodMs } },
      leaseTtlMs: 1_000,
    });
    expect(existingWaiterRetry.status).toBe('blocked');
    if (existingWaiterRetry.status !== 'blocked') {
      throw new Error('expected blocked');
    }
    expect(existingWaiterRetry.retryAfterMs).toBeGreaterThan(5_000);
  });

  test('persists nextWaiter metadata and emits lock_waiter_queued on release', async () => {
    const limits = createLimits(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.drizzle
    );
    const runs = createRunsStorage(db.drizzle);
    const queue = { queue: vi.fn().mockResolvedValue(undefined) };
    const events = createEventsStorage(db.drizzle, {
      getLimits: () => limits,
      queue,
      runs,
    });
    const ownerA = await createLockOwner('holder-a');
    const ownerB = await createLockOwner('holder-b');
    const correlationA = createLockCorrelationId(
      ownerA.runId,
      ownerA.lockIndex
    );
    const correlationB = createLockCorrelationId(
      ownerB.runId,
      ownerB.lockIndex
    );

    const first = await events.create(ownerA.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationA,
      eventData: {
        key: 'workflow:user:test',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });
    const second = await events.create(ownerB.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationB,
      eventData: {
        key: 'workflow:user:test',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });

    expect(first.event?.eventType).toBe('lock_acquired');
    expect(second.event?.eventType).toBe('lock_created');

    const released = await events.create(ownerA.runId, {
      eventType: 'lock_release',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationA,
    });

    if (!released.event || released.event.eventType !== 'lock_release') {
      throw new Error('expected lock_release event');
    }
    expect(released.event?.eventData?.nextWaiter).toMatchObject({
      runId: ownerB.runId,
      lockIndex: ownerB.lockIndex,
      lockCorrelationId: correlationB,
    });
    expect(queue.queue).toHaveBeenCalledWith(
      '__wkf_workflow_holder-b',
      expect.objectContaining({
        runId: ownerB.runId,
        lockPreApproval: correlationB,
      }),
      expect.objectContaining({
        idempotencyKey: expect.any(String),
      })
    );

    const correlated = await events.listByCorrelationId({
      correlationId: correlationB,
    });
    expect(
      correlated.data.some((event) => event.eventType === 'lock_waiter_queued')
    ).toBe(true);
  });

  test('throws when the same key is acquired with a conflicting definition', async () => {
    const limits = createLimits(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.drizzle
    );

    await expect(
      limits.acquire({
        key: 'shared-key',
        runId: 'run-a',
        lockIndex: 0,
        definition: {
          concurrency: { max: 1 },
        },
        leaseTtlMs: 1_000,
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
        leaseTtlMs: 1_000,
      })
    ).rejects.toBeInstanceOf(LimitDefinitionConflictError);
  });

  test('does not resurrect an expired lease when heartbeating after the key lock', async () => {
    const limits = createLimits(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.drizzle
    );

    const first = await limits.acquire({
      key: 'workflow:user:heartbeat-expired',
      runId: 'run-a',
      lockIndex: 0,
      definition: { concurrency: { max: 1 } },
      leaseTtlMs: 50,
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected acquisition');

    await new Promise((resolve) => setTimeout(resolve, 75));

    await expect(
      limits.heartbeat({
        leaseId: first.lease.leaseId,
      })
    ).rejects.toMatchObject({
      name: 'WorkflowWorldError',
      message: expect.stringContaining('not found'),
    });
  });
}
