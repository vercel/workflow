import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleClient } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import * as Schema from '../src/drizzle/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

/**
 * Timestamps must be correct instants no matter which time zone the
 * Postgres server (or the client session) is in.
 *
 * `created_at` comes from the column default `now()`. When the column was
 * `timestamp without time zone`, Postgres stored the server's local wall
 * time and drizzle read it back as UTC, so on an America/Los_Angeles server
 * every `createdAt` landed 7 hours before the `startedAt` written by
 * JavaScript.
 */

const MIGRATIONS = fileURLToPath(
  new URL('../src/drizzle/migrations', import.meta.url)
);
/** The last migration that shipped with `timestamp without time zone`. */
const LAST_NAIVE_MIGRATION = 26;
/** Host and container clocks may disagree a little; the bug is hours. */
const CLOCK_SKEW_MS = 30_000;

const TABLES = [
  'workflow_runs',
  'workflow_events',
  'workflow_steps',
  'workflow_hooks',
  'workflow_waits',
  'workflow_invocations',
  'workflow_snapshots',
  'workflow_stream_chunks',
] as const;

function defined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

function expectNear(actual: Date | undefined, before: number, after: number) {
  const ms = defined(actual).getTime();
  expect(ms).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);
  expect(ms).toBeLessThanOrEqual(after + CLOCK_SKEW_MS);
}

/** Postgres keeps microseconds; JavaScript dates keep milliseconds. */
function expectSameInstant(actual: Date | null | undefined, expected: Date) {
  const ms = defined(actual).getTime();
  expect(Math.abs(ms - expected.getTime())).toBeLessThanOrEqual(1);
}

/**
 * `pool.end()` resolves before its connections finish closing, so stopping
 * the container can still send "terminating connection due to administrator
 * command" (57P01) to a closing client. The pool re-emits that on itself, and
 * with no listener it becomes an uncaught exception that fails the run. Any
 * other error is still thrown.
 */
function ignoreShutdownErrors(pool: Pool): Pool {
  pool.on('error', (error: Error & { code?: string }) => {
    if (error.code !== '57P01') throw error;
  });
  return pool;
}

async function runMigrations(
  connectionString: string,
  options: { migrationsFolder?: string; pool?: PoolConfig } = {}
) {
  const pool = ignoreShutdownErrors(
    new Pool({ connectionString, max: 1, ...options.pool })
  );
  try {
    // Same table and schema names as the `bootstrap` CLI (src/cli.ts).
    await migrate(drizzleClient(pool), {
      migrationsFolder: options.migrationsFolder ?? MIGRATIONS,
      migrationsTable: 'workflow_migrations',
      migrationsSchema: 'workflow_drizzle',
    });
  } finally {
    await pool.end();
  }
}

/** A copy of the migrations folder that stops where 5.0.x stopped. */
function naiveMigrationsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'world-postgres-migrations-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx <= LAST_NAIVE_MIGRATION
  );
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}

describe('migration journal', () => {
  it('orders every migration after the one before it', () => {
    // The drizzle migrator applies a migration only when its `when` is later
    // than the last one applied, so a duplicate or earlier `when` is skipped
    // silently on databases that already ran its predecessor.
    const { entries } = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; when: number; tag: string }[] };
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.startsWith(String(i).padStart(4, '0'))).toBe(true);
      if (i > 0) expect(entry.when).toBeGreaterThan(entries[i - 1].when);
    });
  });
});

if (process.platform === 'win32') {
  // These tests rely on a docker container.
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  describe('timestamps across Postgres time zones', () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let admin: Pool;
    let naiveMigrations: string;
    const pools: Pool[] = [];

    function databaseUrl(database: string): string {
      const url = new URL(container.getConnectionUri());
      url.pathname = `/${database}`;
      return url.toString();
    }

    /** Creates a database whose sessions default to `timeZone`. */
    async function createDatabase(
      name: string,
      timeZone?: string
    ): Promise<string> {
      await admin.query(`CREATE DATABASE "${name}"`);
      if (timeZone) {
        await admin.query(
          `ALTER DATABASE "${name}" SET timezone TO '${timeZone}'`
        );
      }
      return databaseUrl(name);
    }

    function openPool(connectionString: string, config: PoolConfig = {}) {
      const pool = ignoreShutdownErrors(
        new Pool({ connectionString, max: 2, ...config })
      );
      pools.push(pool);
      return pool;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      admin = ignoreShutdownErrors(
        new Pool({ connectionString: container.getConnectionUri() })
      );
      naiveMigrations = naiveMigrationsFolder();
    }, 120_000);

    afterAll(async () => {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin?.end();
      await container?.stop();
      if (naiveMigrations) rmSync(naiveMigrations, { recursive: true });
    });

    /**
     * Drives a run through the World's storage API and checks that every
     * timestamp it hands back, on write and on read, is the current instant.
     */
    async function expectWorldTimestampsAreNow(pool: Pool) {
      const db = createClient(pool);
      const events = createEventsStorage(db);
      const runs = createRunsStorage(db);
      const steps = createStepsStorage(db);
      const hooks = createHooksStorage(db);

      const before = Date.now();
      const created = await events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'dpl_timezone',
          workflowName: 'timezone',
          input: new Uint8Array(),
        },
      });
      const runId = defined(created.run).runId;
      const started = await events.create(runId, { eventType: 'run_started' });
      const stepCreated = await events.create(runId, {
        eventType: 'step_created',
        correlationId: 'step_timezone',
        eventData: { stepName: 'timezone', input: new Uint8Array() },
      });
      const stepStarted = await events.create(runId, {
        eventType: 'step_started',
        correlationId: 'step_timezone',
      });
      const hookCreated = await events.create(runId, {
        eventType: 'hook_created',
        correlationId: 'hook_timezone',
        eventData: { token: `token_${runId}` },
      });
      const waitCreated = await events.create(runId, {
        eventType: 'wait_created',
        correlationId: 'wait_timezone',
        eventData: { resumeAt: new Date(before + 60_000) },
      });
      const after = Date.now();

      const run = defined(started.run);
      const step = defined(stepStarted.step);
      expectNear(defined(created.run).createdAt, before, after);
      expectNear(run.createdAt, before, after);
      expectNear(run.startedAt, before, after);
      expectNear(defined(stepCreated.step).createdAt, before, after);
      expectNear(step.createdAt, before, after);
      expectNear(step.startedAt, before, after);
      expectNear(defined(hookCreated.hook).createdAt, before, after);
      expectNear(defined(waitCreated.wait).createdAt, before, after);
      for (const result of [
        created,
        started,
        stepCreated,
        stepStarted,
        hookCreated,
        waitCreated,
      ]) {
        expectNear(defined(result.event).createdAt, before, after);
      }

      // Reads agree with what the writes returned.
      expectSameInstant((await runs.get(runId)).createdAt, run.createdAt);
      expectSameInstant(
        (await steps.get(runId, 'step_timezone')).createdAt,
        step.createdAt
      );
      expectSameInstant(
        (await hooks.get(defined(hookCreated.hook).hookId)).createdAt,
        defined(hookCreated.hook).createdAt
      );
      const listed = await events.list({ runId, pagination: { limit: 100 } });
      expect(listed.data).toHaveLength(6);
      for (const event of listed.data) {
        expectNear(event.createdAt, before, after);
      }
    }

    for (const timeZone of ['America/Los_Angeles', 'Asia/Kolkata']) {
      it(`keeps createdAt correct on a server in ${timeZone}`, async () => {
        const url = await createDatabase(
          `fresh_${timeZone.replace(/\W/g, '_').toLowerCase()}`,
          timeZone
        );
        await runMigrations(url);
        await expectWorldTimestampsAreNow(openPool(url));
      }, 60_000);
    }

    it('keeps createdAt correct when the pool sets its own session time zone', async () => {
      const url = await createDatabase('fresh_session_tokyo');
      await runMigrations(url);
      await expectWorldTimestampsAreNow(
        openPool(url, { options: '-c TimeZone=Asia/Tokyo' })
      );
    }, 60_000);

    it('stores every timestamp as timestamp with time zone', async () => {
      const url = await createDatabase('fresh_schema');
      await runMigrations(url);
      const { rows: columns } = await openPool(url).query<{
        table_name: string;
        column_name: string;
        data_type: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_name, data_type, column_default
         FROM information_schema.columns
         WHERE table_schema = 'workflow' AND data_type LIKE 'timestamp%'`
      );
      expect(columns.length).toBeGreaterThan(20);
      expect(
        columns.filter((c) => c.data_type !== 'timestamp with time zone')
      ).toEqual([]);
      expect(
        columns
          .filter((c) => c.column_name === 'created_at')
          .map((c) => `${c.table_name} ${c.column_default}`)
          .sort()
      ).toEqual(
        [...TABLES, 'workflow_start_hook_admissions']
          .map((table) => `${table} now()`)
          .sort()
      );
    }, 60_000);

    describe('upgrading a database written by 5.0.x', () => {
      /**
       * Writes rows the way world-postgres 5.0.x did against the
       * `timestamp without time zone` schema: `created_at` (and `updated_at`
       * until the first update) from `DEFAULT now()`, and every other
       * timestamp from a JavaScript `Date` sent as an ISO string.
       */
      async function writeLegacyRows(pool: Pool) {
        const js = new Date();
        const iso = js.toISOString();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO workflow.workflow_runs (id, deployment_id, status, name)
             VALUES ('wrun_fresh', 'dpl', 'pending', 'legacy'),
                    ('wrun_started', 'dpl', 'pending', 'legacy')`
          );
          await client.query(
            `UPDATE workflow.workflow_runs
             SET status = 'running', started_at = $1, updated_at = $1
             WHERE id = 'wrun_started'`,
            [iso]
          );
          await client.query(
            `INSERT INTO workflow.workflow_events (id, type, run_id)
             VALUES ('evnt_legacy', 'run_created', 'wrun_started')`
          );
          // A `now()` from another season: written under that day's offset,
          // which the repair has to use instead of today's.
          const {
            rows: [{ winter }],
          } = await client.query<{ winter: Date }>(
            `SELECT timestamptz '2026-01-15 10:00:00' AS winter`
          );
          await client.query(
            `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
             VALUES ('evnt_winter', 'run_created', 'wrun_started', $1::timestamptz)`,
            [winter.toISOString()]
          );
          await client.query(
            `INSERT INTO workflow.workflow_steps (run_id, step_id, step_name, status, attempt)
             VALUES ('wrun_started', 'step_fresh', 'legacy', 'pending', 0),
                    ('wrun_started', 'step_started', 'legacy', 'pending', 0)`
          );
          await client.query(
            `UPDATE workflow.workflow_steps
             SET status = 'running', attempt = 1, started_at = $1, updated_at = $1
             WHERE step_id = 'step_started'`,
            [iso]
          );
          await client.query(
            `INSERT INTO workflow.workflow_hooks
               (run_id, hook_id, token, owner_id, project_id, environment)
             VALUES ('wrun_started', 'hook_legacy', 'token_legacy', 'o', 'p', 'e')`
          );
          await client.query(
            `INSERT INTO workflow.workflow_waits (wait_id, run_id, status, resume_at)
             VALUES ('wait_fresh', 'wrun_started', 'waiting', $1),
                    ('wait_completed', 'wrun_started', 'waiting', $1)`,
            [iso]
          );
          await client.query(
            `UPDATE workflow.workflow_waits
             SET status = 'completed', completed_at = $1, updated_at = $1
             WHERE wait_id = 'wait_completed'`,
            [iso]
          );
          await client.query(
            `INSERT INTO workflow.workflow_invocations (run_id, request_id, payload, fingerprint)
             VALUES ('wrun_started', 'req_legacy', '\\x00', 'f')`
          );
          await client.query(
            `UPDATE workflow.workflow_invocations
             SET result = '\\x01', responded_at = now()
             WHERE request_id = 'req_legacy'`
          );
          await client.query(
            `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, run_id, data, eof)
             VALUES ('chnk_legacy', 'strm_legacy', 'wrun_started', '\\x00', false)`
          );
          await client.query(
            `INSERT INTO workflow.workflow_snapshots (run_id, data, created_at)
             VALUES ('wrun_started', '\\x00', $1)`,
            [iso]
          );
          // `now()` is the transaction start: the instant every defaulted
          // column above meant to record. node-postgres parses it correctly.
          const {
            rows: [{ now }],
          } = await client.query<{ now: Date }>('SELECT now() AS now');
          await client.query('COMMIT');
          return { now, js, winter };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }

      /** Reads every timestamp back through the World's drizzle schema. */
      async function expectRepaired(
        pool: Pool,
        { now, js, winter }: { now: Date; js: Date; winter: Date }
      ) {
        const db = createClient(pool);
        const run = async (id: string) => {
          const rows = await db
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, id));
          return defined(rows[0]);
        };
        const step = async (id: string) => {
          const rows = await db
            .select()
            .from(Schema.steps)
            .where(eq(Schema.steps.stepId, id));
          return defined(rows[0]);
        };
        const wait = async (id: string) => {
          const rows = await db
            .select()
            .from(Schema.waits)
            .where(eq(Schema.waits.waitId, id));
          return defined(rows[0]);
        };

        const freshRun = await run('wrun_fresh');
        expectSameInstant(freshRun.createdAt, now);
        expectSameInstant(freshRun.updatedAt, now);
        const startedRun = await run('wrun_started');
        expectSameInstant(startedRun.createdAt, now);
        expectSameInstant(startedRun.updatedAt, js);
        expectSameInstant(startedRun.startedAt, js);

        const event = async (id: string) => {
          const rows = await db
            .select()
            .from(Schema.events)
            .where(eq(Schema.events.eventId, id));
          return defined(rows[0]);
        };
        expectSameInstant((await event('evnt_legacy')).createdAt, now);
        expectSameInstant((await event('evnt_winter')).createdAt, winter);

        const freshStep = await step('step_fresh');
        expectSameInstant(freshStep.createdAt, now);
        expectSameInstant(freshStep.updatedAt, now);
        const startedStep = await step('step_started');
        expectSameInstant(startedStep.createdAt, now);
        expectSameInstant(startedStep.updatedAt, js);
        expectSameInstant(startedStep.startedAt, js);

        const [hook] = await db.select().from(Schema.hooks);
        expectSameInstant(hook.createdAt, now);

        const freshWait = await wait('wait_fresh');
        expectSameInstant(freshWait.createdAt, now);
        expectSameInstant(freshWait.updatedAt, now);
        expectSameInstant(freshWait.resumeAt, js);
        const completedWait = await wait('wait_completed');
        expectSameInstant(completedWait.createdAt, now);
        expectSameInstant(completedWait.updatedAt, js);
        expectSameInstant(completedWait.completedAt, js);

        const [invocation] = await db.select().from(Schema.invocations);
        expectSameInstant(invocation.createdAt, now);
        expectSameInstant(invocation.respondedAt, now);

        const [chunk] = await db.select().from(Schema.streams);
        expectSameInstant(chunk.createdAt, now);

        const [snapshot] = await db.select().from(Schema.snapshots);
        expectSameInstant(snapshot.createdAt, js);
      }

      /** The storage file of every table and index in the 8 tables. */
      async function storageFiles(pool: Pool) {
        const { rows } = await pool.query<{ relation: string; file: string }>(
          `SELECT c.relname AS relation, pg_relation_filenode(c.oid)::text AS file
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_index i ON i.indexrelid = c.oid
           WHERE n.nspname = 'workflow'
             AND coalesce(i.indrelid, c.oid) IN (
               SELECT format('workflow.%I', t)::regclass FROM unnest($1::text[]) AS t
             )
           ORDER BY c.relname`,
          [TABLES]
        );
        return Object.fromEntries(rows.map((row) => [row.relation, row.file]));
      }

      it('converts local wall times written on a non-UTC server', async () => {
        const url = await createDatabase(
          'upgrade_los_angeles',
          'America/Los_Angeles'
        );
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const legacy = await writeLegacyRows(openPool(url));

        await runMigrations(url);

        await expectRepaired(openPool(url), legacy);
      }, 60_000);

      it('converts without rewriting tables on a UTC server', async () => {
        // The container's default time zone.
        const url = await createDatabase('upgrade_utc');
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const pool = openPool(url);
        const legacy = await writeLegacyRows(pool);
        const before = await storageFiles(pool);

        await runMigrations(url);

        // Only the partial index whose predicate reads `responded_at` is
        // rebuilt; tables and every other index keep their storage. Later
        // migrations only add relations.
        const after = await storageFiles(pool);
        expect(Object.keys(after).filter((name) => !(name in before))).toEqual([
          'workflow_hooks_token_claim_unique',
        ]);
        expect(Object.keys(after)).toEqual(
          expect.arrayContaining(Object.keys(before))
        );
        expect(
          Object.keys(before).filter((name) => after[name] !== before[name])
        ).toEqual(['workflow_invocations_pending']);
        await expectRepaired(pool, legacy);
      }, 60_000);

      it('repairs once when two bootstrap processes migrate at the same time', async () => {
        const url = await createDatabase(
          'upgrade_concurrent',
          'America/Los_Angeles'
        );
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const legacy = await writeLegacyRows(openPool(url));

        // The drizzle migrator takes no lock, so both can apply 0027.
        await Promise.all([runMigrations(url), runMigrations(url)]);

        await expectRepaired(openPool(url), legacy);
      }, 60_000);

      it('changes nothing when 0027 runs again on a converted database', async () => {
        const url = await createDatabase(
          'upgrade_reapplied',
          'America/Los_Angeles'
        );
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const legacy = await writeLegacyRows(openPool(url));
        await runMigrations(url);

        await openPool(url).query(
          readFileSync(
            join(MIGRATIONS, '0027_timestamps_with_time_zone.sql'),
            'utf8'
          )
        );

        await expectRepaired(openPool(url), legacy);
      }, 60_000);

      it('gives up waiting for its locks instead of stalling the World', async () => {
        const url = await createDatabase('upgrade_lock_timeout');
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const legacy = await writeLegacyRows(openPool(url));

        // A long transaction still holding a lock on one of the tables.
        const holder = await openPool(url).connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM workflow.workflow_events LIMIT 1');
          const started = Date.now();
          await expect(runMigrations(url)).rejects.toMatchObject({
            cause: { code: '55P03' },
          });
          expect(Date.now() - started).toBeLessThan(30_000);
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
        }

        await runMigrations(url);
        await expectRepaired(openPool(url), legacy);
      }, 60_000);

      it('reads unconverted columns as UTC in a Node process outside UTC', async () => {
        // The upgraded app can start before `bootstrap` runs 0027. The
        // unconverted columns print without an offset; reading them in
        // Node's local time zone would move a `retryAfter` by hours.
        const url = await createDatabase('upgrade_node_los_angeles');
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const pool = openPool(url);
        const legacy = await writeLegacyRows(pool);
        await pool.query(
          `UPDATE workflow.workflow_steps SET retry_after = $1
           WHERE step_id = 'step_started'`,
          [legacy.js.toISOString()]
        );

        const tz = process.env.TZ;
        process.env.TZ = 'America/Los_Angeles';
        try {
          expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(480);
          const [step] = await createClient(pool)
            .select()
            .from(Schema.steps)
            .where(eq(Schema.steps.stepId, 'step_started'));
          expectSameInstant(defined(step).retryAfter, legacy.js);
          expectSameInstant(defined(step).startedAt, legacy.js);
          expectSameInstant(defined(step).createdAt, legacy.now);
        } finally {
          if (tz === undefined) delete process.env.TZ;
          else process.env.TZ = tz;
        }
      }, 60_000);

      it('honors workflow.legacy_timezone when the app wrote in another session time zone', async () => {
        const url = await createDatabase('upgrade_session_tokyo');
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const legacy = await writeLegacyRows(
          openPool(url, { options: '-c TimeZone=Asia/Tokyo' })
        );

        await runMigrations(url, {
          pool: { options: '-c workflow.legacy_timezone=Asia/Tokyo' },
        });

        await expectRepaired(openPool(url), legacy);
      }, 60_000);

      it('honors workflow.legacy_timezone set with ALTER DATABASE', async () => {
        // For poolers that drop startup `options`.
        const url = await createDatabase('upgrade_database_setting');
        await runMigrations(url, { migrationsFolder: naiveMigrations });
        const legacy = await writeLegacyRows(
          openPool(url, { options: '-c TimeZone=Asia/Tokyo' })
        );
        await admin.query(
          `ALTER DATABASE "upgrade_database_setting" SET workflow.legacy_timezone = 'Asia/Tokyo'`
        );

        await runMigrations(url);

        await expectRepaired(openPool(url), legacy);
      }, 60_000);
    });
  });
}
