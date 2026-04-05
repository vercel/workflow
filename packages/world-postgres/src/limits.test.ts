import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterAll, beforeAll, beforeEach, test, vi } from 'vitest';
import { createLimitsContractSuite } from '../../world-testing/src/limits-contract.mts';
import { createLimitsEventsContractSuite } from '../../world-testing/src/limits-events-contract.mts';
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

  createLimitsEventsContractSuite('postgres world limit events', async () => {
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
    return {
      queue,
      prepareQueueFailure: () => {
        queue.queue
          .mockRejectedValueOnce(new Error('queue failed'))
          .mockResolvedValue(undefined);
      },
      createOwner: createLockOwner,
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
            definition: { concurrency: { max: concurrencyMax } },
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
}
