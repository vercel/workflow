import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { lockConformance } from '../../world/src/test-support/lock-conformance.js';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import { createLocksStorage } from '../src/locks.js';
import { createEventsStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * Native concurrency locks on the Postgres World: the shared conformance
 * suite, with a second events storage on the same database racing the first.
 */
describe('locks (world-postgres)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let events: ReturnType<typeof createEventsStorage>;

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
    // Enough connections for concurrent grants to really overlap.
    pool = new TestPool({ connectionString: dbUrl, max: 24 });
    events = createEventsStorage(createClient(pool));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  lockConformance({
    name: 'world-postgres',
    events: () => events,
    secondEvents: () => createEventsStorage(createClient(pool)),
    locks: () => createLocksStorage(createClient(pool)),
    capabilities: () => createWorld({ pool }).capabilities,
    newRunId: () => `wrun_${ulid()}`,
    concurrentAcquirers: 16,
  });
});
