import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { atomicStartHookConformance } from '../../world/src/test-support/atomic-start-hook-conformance.js';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import { createEventsStorage, createRunsStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * `start({ hook })` admission: the decision and the run it admits commit in
 * one transaction, serialized per token by an advisory lock shared with
 * `createHook()`.
 */
describe('atomic start Hook (world-postgres)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let events: ReturnType<typeof createEventsStorage>;
  let runs: ReturnType<typeof createRunsStorage>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    // Enough connections for the concurrent candidates to really overlap.
    pool = new TestPool({ connectionString: dbUrl, max: 16 });
    const drizzle = createClient(pool);
    events = createEventsStorage(drizzle);
    runs = createRunsStorage(drizzle);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  atomicStartHookConformance({
    name: 'world-postgres',
    storage: () => ({ events, runs }),
    secondEvents: () => createEventsStorage(createClient(pool)),
    capabilities: () => createWorld({ pool }).capabilities,
    newRunId: () => `wrun_${ulid()}`,
    concurrentCandidates: 12,
  });
});
