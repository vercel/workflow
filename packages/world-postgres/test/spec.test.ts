import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestSuite } from '@workflow/world-testing';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createWorld } from '../src/index.js';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('raises retry limits for active jobs without reviving failed jobs', async () => {
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const utils = await makeWorkerUtils({ pgPool: pool });
    const runAt = new Date(Date.now() + 60_000);
    const active = await utils.addJob(
      'workflow_flows',
      {},
      {
        maxAttempts: 3,
        runAt,
      }
    );
    const failed = await utils.addJob(
      'workflow_flows',
      {},
      {
        maxAttempts: 3,
        runAt,
      }
    );
    await pool.query(
      `UPDATE graphile_worker._private_jobs
      SET attempts = max_attempts, locked_at = now(), locked_by = 'old-worker'
      WHERE id = $1`,
      [active.id]
    );
    await pool.query(
      `UPDATE graphile_worker._private_jobs
      SET attempts = max_attempts
      WHERE id = $1`,
      [failed.id]
    );
    await utils.release();

    const world = createWorld({
      connectionString: container.getConnectionUri(),
      pool,
    });
    await world.start();

    const jobs = await pool.query(
      `SELECT id, max_attempts FROM graphile_worker.jobs
      WHERE id = ANY($1::bigint[])`,
      [[active.id, failed.id]]
    );
    expect(jobs.rows).toEqual(
      expect.arrayContaining([
        { id: active.id, max_attempts: 49 },
        { id: failed.id, max_attempts: 3 },
      ])
    );

    await world.close();
    await pool.end();
  });
  createTestSuite('./dist/index.js');
}
