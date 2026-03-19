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
  let queue: ReturnType<typeof createQueue>;

  beforeAll(async () => {
    const { createPostgresTestDb } = await import('../test/test-db.js');
    db = await createPostgresTestDb();
    queue = createQueue(
      { connectionString: db.connectionString, queueConcurrency: 1 },
      db.sql
    );
    await queue.start();
  }, 120_000);

  beforeEach(async () => {
    await db.truncateLimits();
  });

  afterAll(async () => {
    await queue?.close();
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
    };
  });
}
