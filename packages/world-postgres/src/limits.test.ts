import { afterAll, beforeAll, beforeEach, test } from 'vitest';
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
            from workflow.workflow_limit_tokens
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
}
