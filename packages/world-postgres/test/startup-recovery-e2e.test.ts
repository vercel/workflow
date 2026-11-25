import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import {
  createFetcher,
  startServer,
} from '@workflow/world-testing/dist/src/util.mjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createWorld } from '../src/index.js';
import { TestPool } from './pool.js';

/**
 * `startup-recovery.test.ts` stands in for a delivery's clear with SQL. This
 * drives a real hook workflow through the world-testing server, so the clear
 * comes from the queue's own completed delivery (the lease path on spec 9),
 * and checks that a parked run still resumes after a boot skipped it.
 */
describe.each([
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
])('startup recovery of a real parked run at spec %i', (specVersion) => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;

    pool = new TestPool({ connectionString: dbUrl });
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(
        new URL('../src/drizzle/migrations', import.meta.url)
      ),
      migrationsTable: 'workflow_migrations',
      migrationsSchema: 'workflow_drizzle',
    });
  }, 120_000);

  afterAll(async () => {
    if (originalBaseUrl === undefined) {
      delete process.env.WORKFLOW_LOCAL_BASE_URL;
    } else {
      process.env.WORKFLOW_LOCAL_BASE_URL = originalBaseUrl;
    }
    await pool?.end();
    await container?.stop();
  });

  async function wakePending(runId: string): Promise<boolean | undefined> {
    const { rows } = await pool.query<{ wake_pending: boolean }>(
      'SELECT wake_pending FROM workflow.workflow_runs WHERE id = $1',
      [runId]
    );
    return rows[0]?.wake_pending;
  }

  async function recoveryJobCount(runId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM graphile_worker._private_jobs WHERE key = $1',
      [`startup-recovery:${runId}`]
    );
    return Number(rows[0]?.count);
  }

  /** Another process booting against the same database. */
  async function boot() {
    const world = createWorld({ pool });
    await world.start();
    return world;
  }

  test(
    'skips the parked run, recovers it once flagged, and the run still resumes',
    { timeout: 90_000 },
    async () => {
      const control = await startServer({
        world: './dist/index.js',
        env: { WORKFLOW_SPEC_VERSION: String(specVersion) },
      });
      const server = createFetcher(control);
      // A booting World delivers what it recovers to the run's own server,
      // whose flow invocation count then shows it.
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${control.info.port}`;

      const token = `parked-${specVersion}-${Date.now().toString(36)}`;
      const { runId } = await server.invoke(
        'workflows/hooks.ts',
        'collectWithHook',
        [token, 'custom']
      );

      // Parked: the hook is open, its first step is done, and the delivery
      // that saw that completed and cleared the flag.
      await vi.waitFor(
        async () => {
          const events = await server.getEvents(runId);
          expect(
            events.some((event) => event.eventType === 'hook_created')
          ).toBe(true);
          expect(
            events.some((event) => event.eventType === 'step_completed')
          ).toBe(true);
          expect(await wakePending(runId)).toBe(false);
        },
        { interval: 200, timeout: 30_000 }
      );
      expect((await server.getRun(runId)).status).toBe('running');
      const parkedInvocations = await server.getFlowInvocationCount(runId);

      const skipped = await boot();
      try {
        expect(await recoveryJobCount(runId)).toBe(0);
        // Long enough for a recovery job to have been delivered.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(await server.getFlowInvocationCount(runId)).toBe(
          parkedInvocations
        );
      } finally {
        await skipped.close();
      }

      // An owed wake makes the next boot deliver the run, and that delivery
      // clears the flag again.
      await pool.query(
        'UPDATE workflow.workflow_runs SET wake_pending = true WHERE id = $1',
        [runId]
      );
      const recovered = await boot();
      try {
        await vi.waitFor(
          async () => {
            expect(await server.getFlowInvocationCount(runId)).toBeGreaterThan(
              parkedInvocations
            );
            expect(await wakePending(runId)).toBe(false);
          },
          { interval: 200, timeout: 30_000 }
        );
      } finally {
        await recovered.close();
      }

      await server.resumeHook(token, { data: 'last', done: true });
      await vi.waitFor(
        async () => {
          expect((await server.getRun(runId)).status).toBe('completed');
        },
        { interval: 200, timeout: 30_000 }
      );
    }
  );
});
