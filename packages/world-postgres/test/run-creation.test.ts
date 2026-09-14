import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { EntityConflictError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createEventsStorage } from '../src/storage.js';

/**
 * A run row, its slot marker and its run_created event have to become visible
 * together. A concurrent writer that sees the row without the marker takes the
 * run for a legacy (ULID-numbered) one, and a creation that fails after the
 * row is in place leaves a run with no first event. Both creation sites are
 * covered: an explicit run_created, and the resilient run_started that
 * recreates the run from the queued message.
 */
describe('atomic run creation', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  // Identifies the storage's connections in pg_stat_activity, so a test can
  // tell when its creation is parked on a lock the test holds.
  const applicationName = `run_creation_${randomUUID().replaceAll('-', '')}`;

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let observer: Pool;
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

    pool = new Pool({
      connectionString: dbUrl,
      application_name: applicationName,
      max: 1,
    });
    // The observer's connections are separate from the storage's so that a
    // lock the observer holds does not starve the creation of a connection,
    // and its reads see exactly what another writer would.
    observer = new Pool({ connectionString: dbUrl, max: 2 });
    events = createEventsStorage(createClient(pool));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await observer.end();
    await container.stop();
  });

  const create = (runId: string, eventType: 'run_created' | 'run_started') =>
    events.create(runId, {
      eventType,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'run-creation-test',
        input: new Uint8Array([1]),
      },
    });

  test.each([
    ['run_created', 'workflow_event_slots'],
    ['run_created', 'workflow_events'],
    ['run_started', 'workflow_event_slots'],
    ['run_started', 'workflow_events'],
  ] as const)('%s remains invisible while its %s insert is blocked', async (eventType, blockedTable) => {
    const runId = `wrun_${ulid()}`;
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      `LOCK TABLE workflow.${blockedTable} IN ACCESS EXCLUSIVE MODE`
    );
    const creation = create(runId, eventType);
    try {
      // Wait until the creation has inserted the run row and is parked on
      // the locked table; only then does the visibility check mean anything.
      await expect
        .poll(async () => {
          const result = await observer.query(
            `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE application_name = $1
               AND wait_event_type = 'Lock' AND query LIKE $2`,
            [applicationName, `%${blockedTable}%`]
          );
          return result.rows[0].count;
        })
        .toBe(1);
      const visible = await observer.query(
        'SELECT id FROM workflow.workflow_runs WHERE id = $1',
        [runId]
      );
      expect(visible.rows).toEqual([]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await creation;
    }
    const stored = await observer.query(
      'SELECT id, type FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id',
      [runId]
    );
    const expected = [
      { id: 'evnt_00000000000000000000000001', type: 'run_created' },
    ];
    if (eventType === 'run_started') {
      expected.push({
        id: 'evnt_00000000000000000000000002',
        type: 'run_started',
      });
    }
    expect(stored.rows).toEqual(expected);
  });

  test.each([
    'run_created',
    'run_started',
  ] as const)('%s rolls back its run and marker if the first event fails', async (eventType) => {
    const runId = `wrun_${ulid()}`;
    // NOT VALID so existing rows are not checked; only the new run_created
    // insert trips it.
    await observer.query(
      `ALTER TABLE workflow.workflow_events ADD CONSTRAINT reject_created
         CHECK (type <> 'run_created') NOT VALID`
    );
    try {
      await expect(create(runId, eventType)).rejects.toMatchObject({
        cause: { code: '23514' },
      });
      for (const [table, column] of [
        ['workflow_runs', 'id'],
        ['workflow_event_slots', 'run_id'],
        ['workflow_events', 'run_id'],
      ]) {
        const stored = await observer.query(
          `SELECT 1 FROM workflow.${table} WHERE ${column} = $1`,
          [runId]
        );
        expect(stored.rows, table).toEqual([]);
      }
    } finally {
      await observer.query(
        'ALTER TABLE workflow.workflow_events DROP CONSTRAINT reject_created'
      );
    }
  });

  test('a duplicate creator preserves the existing first event', async () => {
    const runId = `wrun_${ulid()}`;
    await create(runId, 'run_started');
    await expect(create(runId, 'run_created')).rejects.toSatisfy(
      EntityConflictError.is
    );
    const stored = await observer.query(
      'SELECT type FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id',
      [runId]
    );
    expect(stored.rows).toEqual([
      { type: 'run_created' },
      { type: 'run_started' },
    ]);
  });
});
