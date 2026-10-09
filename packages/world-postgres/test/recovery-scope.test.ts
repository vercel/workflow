import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import { MessageData } from '../src/message.js';
import { createEventsStorage } from '../src/storage.js';

/**
 * Apps that share one database keep their jobs apart with `jobPrefix`: each
 * World's runner claims only its own `${jobPrefix}flows` task. Startup
 * recovery has to respect the same boundary. A World that re-enqueued every
 * active run in the database into its own task would have its runner drive
 * another app's runs, on every boot.
 */
describe('startup recovery scope', () => {
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

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    pool = new Pool({ connectionString: dbUrl });

    // Point the runner at a loopback port nothing listens on, so it defers
    // its start and every recovered job stays queued where the test can
    // read it.
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('no port'));
        });
      });
    });
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${port}`;
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

  const runEvent = (eventType: 'run_created' | 'run_started') => ({
    eventType,
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'postgres',
      workflowName: 'recovery-scope-test',
      input: new Uint8Array([1]),
    },
  });

  /** The run ids queued on a Graphile task, decoded from the job payloads. */
  async function queuedRunIds(task: string): Promise<string[]> {
    const { rows } = await pool.query<{ payload: unknown }>(
      `SELECT jobs.payload FROM graphile_worker._private_jobs AS jobs
         JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
         WHERE tasks.identifier = $1`,
      [task]
    );
    return rows.map(
      ({ payload }) =>
        JSON.parse(MessageData.parse(payload).data.toString()).runId as string
    );
  }

  test('a World recovers its own and legacy runs, not runs of another prefix', async () => {
    const worldA = createWorld({ pool, jobPrefix: 'app_a_' });
    const worldB = createWorld({ pool, jobPrefix: 'app_b_' });
    // A run written by storage constructed without a World, the same as a
    // run created before `workflow_runs.job_prefix` existed.
    const legacyEvents = createEventsStorage(createClient(pool));

    const runA = `wrun_${ulid()}`;
    const runB = `wrun_${ulid()}`;
    const runLegacy = `wrun_${ulid()}`;
    await worldA.events.create(runA, runEvent('run_created'));
    await worldB.events.create(runB, runEvent('run_created'));
    await legacyEvents.create(runLegacy, runEvent('run_created'));
    const ours = new Set([runA, runB, runLegacy]);

    try {
      await worldA.start();
      const recoveredByA = (await queuedRunIds('app_a_flows')).filter((id) =>
        ours.has(id)
      );
      expect(recoveredByA.sort()).toEqual([runA, runLegacy].sort());

      await worldB.start();
      const recoveredByB = (await queuedRunIds('app_b_flows')).filter((id) =>
        ours.has(id)
      );
      expect(recoveredByB.sort()).toEqual([runB, runLegacy].sort());

      // The public listing stays unscoped: the CLI and the dashboard still
      // see every run in the database.
      const listed = await worldA.runs.list({
        status: ['pending', 'running'],
        resolveData: 'none',
        pagination: { limit: 100 },
      });
      expect(listed.data.map((run) => run.runId)).toEqual(
        expect.arrayContaining([runA, runB, runLegacy])
      );
    } finally {
      await worldA.close();
      await worldB.close();
    }
  });

  test('both run creation paths stamp the effective jobPrefix of the World', async () => {
    const custom = createWorld({ pool, jobPrefix: 'app_c_' });
    const defaults = createWorld({ pool });

    const created = `wrun_${ulid()}`;
    const resilient = `wrun_${ulid()}`;
    const defaulted = `wrun_${ulid()}`;
    try {
      const result = await custom.events.create(
        created,
        runEvent('run_created')
      );
      // run_started on a run that does not exist yet recreates it from the
      // queued message, the second place a run row is inserted.
      await custom.events.create(resilient, runEvent('run_started'));
      await defaults.events.create(defaulted, runEvent('run_created'));

      // The prefix is routing metadata, not part of the run's public shape.
      expect(result.run).toBeDefined();
      expect(result.run).not.toHaveProperty('jobPrefix');
    } finally {
      await custom.close();
      await defaults.close();
    }

    const { rows } = await pool.query<{ id: string; job_prefix: string }>(
      'SELECT id, job_prefix FROM workflow.workflow_runs WHERE id = ANY($1)',
      [[created, resilient, defaulted]]
    );
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.job_prefix]))
    ).toEqual({
      [created]: 'app_c_',
      [resilient]: 'app_c_',
      [defaulted]: 'workflow_',
    });
  });
});
