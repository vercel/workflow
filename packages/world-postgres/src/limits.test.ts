import { createLockCorrelationId, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.mts';
import { createLimits } from './limits.js';
import { createQueue } from './queue.js';
import {
  createEventsStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';

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
      db.pool
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
          db.pool.query<{ lockId: string }>(
            `
              select holder_id as "lockId"
              from workflow.workflow_limit_leases
              where limit_key = $1
              order by holder_id asc
            `,
            [key]
          ),
          db.pool.query<{ lockId: string }>(
            `
              select holder_id as "lockId"
              from workflow.workflow_limit_waiters
              where limit_key = $1
              order by created_at asc, holder_id asc
            `,
            [key]
          ),
          db.pool.query<{ lockId: string }>(
            `
              select holder_id as "lockId"
              from workflow.workflow_rate_limit_tokens
              where limit_key = $1
              order by acquired_at asc, holder_id asc
            `,
            [key]
          ),
        ]);

        return {
          leaseHolderIds: leases.rows.map((row) => row.lockId),
          waiterHolderIds: waiters.rows.map((row) => row.lockId),
          tokenHolderIds: tokens.rows.map((row) => row.lockId),
        };
      },
    };
  });

  test('persists promotedWaiters metadata and emits lock_waiter_queued for every promoted waiter', async () => {
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
    const ownerC = await createLockOwner('holder-c');
    const ownerD = await createLockOwner('holder-d');
    const correlationA = createLockCorrelationId(
      ownerA.runId,
      ownerA.lockIndex
    );
    const correlationB = createLockCorrelationId(
      ownerB.runId,
      ownerB.lockIndex
    );
    const correlationC = createLockCorrelationId(
      ownerC.runId,
      ownerC.lockIndex
    );
    const correlationD = createLockCorrelationId(
      ownerD.runId,
      ownerD.lockIndex
    );

    for (const owner of [ownerA, ownerB, ownerC, ownerD]) {
      await events.create(owner.runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
    }

    const first = await events.create(ownerA.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationA,
      eventData: {
        key: 'workflow:user:test',
        definition: { concurrency: { max: 2 } },
        leaseTtlMs: 1_000,
      },
    });
    const second = await events.create(ownerB.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationB,
      eventData: {
        key: 'workflow:user:test',
        definition: { concurrency: { max: 2 } },
        leaseTtlMs: 1_000,
      },
    });
    const third = await events.create(ownerC.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationC,
      eventData: {
        key: 'workflow:user:test',
        definition: { concurrency: { max: 2 } },
        leaseTtlMs: 1_000,
      },
    });
    const fourth = await events.create(ownerD.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationD,
      eventData: {
        key: 'workflow:user:test',
        definition: { concurrency: { max: 2 } },
        leaseTtlMs: 1_000,
      },
    });

    expect(first.event?.eventType).toBe('lock_acquired');
    expect(second.event?.eventType).toBe('lock_acquired');
    expect(third.event?.eventType).toBe('lock_created');
    expect(fourth.event?.eventType).toBe('lock_created');

    await events.create(ownerB.runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: null },
    });

    const released = await events.create(ownerA.runId, {
      eventType: 'lock_release',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: correlationA,
    });

    if (!released.event || released.event.eventType !== 'lock_release') {
      throw new Error('expected lock_release event');
    }
    expect(released.event.eventData?.promotedWaiters).toEqual([
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
    expect(queue.queue).toHaveBeenCalledTimes(2);

    for (const [workflowName, owner, correlationId] of [
      ['holder-c', ownerC, correlationC],
      ['holder-d', ownerD, correlationD],
    ] as const) {
      expect(queue.queue).toHaveBeenCalledWith(
        `__wkf_workflow_${workflowName}`,
        expect.objectContaining({
          runId: owner.runId,
          lockPreApproval: correlationId,
        }),
        expect.objectContaining({
          idempotencyKey: expect.any(String),
        })
      );

      const correlated = await events.listByCorrelationId({
        correlationId,
      });
      expect(
        correlated.data.some(
          (event) => event.eventType === 'lock_waiter_queued'
        )
      ).toBe(true);
    }
  });

  test('compensates skipped or failed waiter wake-ups and recursively queues the next waiter', async () => {
    const limits = createLimits(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.drizzle
    );
    const runs = createRunsStorage(db.drizzle);
    const queue = {
      queue: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('queue failed'))
        .mockResolvedValue(undefined),
    };
    const events = createEventsStorage(db.drizzle, {
      getLimits: () => limits,
      queue,
      runs,
    });
    const holder = await createLockOwner('holder-a');
    const terminalWaiter = await createLockOwner('holder-b');
    const liveWaiter = await createLockOwner('holder-c');
    const holderCorrelation = createLockCorrelationId(
      holder.runId,
      holder.lockIndex
    );
    const terminalCorrelation = createLockCorrelationId(
      terminalWaiter.runId,
      terminalWaiter.lockIndex
    );
    const liveCorrelation = createLockCorrelationId(
      liveWaiter.runId,
      liveWaiter.lockIndex
    );

    for (const owner of [holder, terminalWaiter, liveWaiter]) {
      await events.create(owner.runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
    }

    await events.create(holder.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: holderCorrelation,
      eventData: {
        key: 'workflow:user:terminal-promoted',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });
    await events.create(terminalWaiter.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: terminalCorrelation,
      eventData: {
        key: 'workflow:user:terminal-promoted',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });
    await events.create(liveWaiter.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: liveCorrelation,
      eventData: {
        key: 'workflow:user:terminal-promoted',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });

    await events.create(terminalWaiter.runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: null },
    });

    await events.create(holder.runId, {
      eventType: 'lock_release',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: holderCorrelation,
    });

    expect(queue.queue).toHaveBeenCalledTimes(1);
    expect(queue.queue).toHaveBeenCalledWith(
      '__wkf_workflow_holder-c',
      expect.objectContaining({
        runId: liveWaiter.runId,
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
      liveEvents.data.some((event) => event.eventType === 'lock_waiter_queued')
    ).toBe(true);

    const failedHolder = await createLockOwner('holder-d');
    const failedFirstWaiter = await createLockOwner('holder-e');
    const failedSecondWaiter = await createLockOwner('holder-f');
    const failedHolderCorrelation = createLockCorrelationId(
      failedHolder.runId,
      failedHolder.lockIndex
    );
    const failedFirstCorrelation = createLockCorrelationId(
      failedFirstWaiter.runId,
      failedFirstWaiter.lockIndex
    );
    const failedSecondCorrelation = createLockCorrelationId(
      failedSecondWaiter.runId,
      failedSecondWaiter.lockIndex
    );

    for (const owner of [failedHolder, failedFirstWaiter, failedSecondWaiter]) {
      await events.create(owner.runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
    }

    await events.create(failedHolder.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: failedHolderCorrelation,
      eventData: {
        key: 'workflow:user:queue-failure',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });
    await events.create(failedFirstWaiter.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: failedFirstCorrelation,
      eventData: {
        key: 'workflow:user:queue-failure',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });
    await events.create(failedSecondWaiter.runId, {
      eventType: 'lock_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: failedSecondCorrelation,
      eventData: {
        key: 'workflow:user:queue-failure',
        definition: { concurrency: { max: 1 } },
        leaseTtlMs: 1_000,
      },
    });

    await events.create(failedHolder.runId, {
      eventType: 'lock_release',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: failedHolderCorrelation,
    });

    expect(queue.queue).toHaveBeenCalledTimes(3);
    expect(queue.queue.mock.calls[1]?.[1]).toMatchObject({
      runId: failedFirstWaiter.runId,
      lockPreApproval: failedFirstCorrelation,
    });
    expect(queue.queue.mock.calls[2]?.[1]).toMatchObject({
      runId: failedSecondWaiter.runId,
      lockPreApproval: failedSecondCorrelation,
    });

    const firstEvents = await events.listByCorrelationId({
      correlationId: failedFirstCorrelation,
    });
    expect(
      firstEvents.data.some((event) => event.eventType === 'lock_waiter_queued')
    ).toBe(false);

    const secondEvents = await events.listByCorrelationId({
      correlationId: failedSecondCorrelation,
    });
    expect(
      secondEvents.data.some(
        (event) => event.eventType === 'lock_waiter_queued'
      )
    ).toBe(true);
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
