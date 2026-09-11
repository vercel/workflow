import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RETENTION_ATTRIBUTE } from '@workflow/world';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createEventsStorage, createRunsStorage } from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';

type EventsStorage = ReturnType<typeof createEventsStorage>;

/** Every payload-bearing column, CBOR half and legacy JSON twin alike. */
const PAYLOAD_COLUMNS = {
  runs: ['input_cbor', 'input', 'output_cbor', 'output', 'error_cbor', 'error'],
  steps: [
    'input_cbor',
    'input',
    'output_cbor',
    'output',
    'error_cbor',
    'error',
  ],
  events: ['payload_cbor', 'payload'],
  hooks: ['metadata_cbor', 'metadata', 'resume_context'],
} as const;

describe('Retention ($retention: 0)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let drizzle: ReturnType<typeof createClient>;
  let runs: ReturnType<typeof createRunsStorage>;
  let events: EventsStorage;
  let streamer: ReturnType<typeof createStreamer>;

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

    pool = new Pool({ connectionString: dbUrl, max: 4 });
    drizzle = createClient(pool);
    runs = createRunsStorage(drizzle);
    events = createEventsStorage(drizzle);
    streamer = createStreamer(pool, drizzle);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE workflow.workflow_events, workflow.workflow_event_slots, ' +
        'workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_waits, ' +
        'workflow.workflow_stream_chunks, workflow.workflow_runs ' +
        'RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  /**
   * A run carrying `attributes`, with a step, a hook, an event log and a
   * closed stream — one of every payload-bearing row the purge has to reach.
   * Every CBOR payload also gets its legacy JSON twin backfilled by hand: no
   * write path populates those columns any more, but old rows have them and
   * the read paths fall back to them, so a purge that misses them resurrects
   * the payload on the next read.
   */
  async function seedRun(attributes?: Record<string, string>) {
    const created = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'deployment-1',
        workflowName: 'retention-workflow',
        input: new Uint8Array([1, 2, 3]),
        executionContext: { userId: 'user-1' },
        ...(attributes ? { attributes, allowReservedAttributes: true } : {}),
      },
    });
    const runId = created.run?.runId;
    if (!runId) throw new Error('Expected run to be created');

    await events.create(runId, { eventType: 'run_started' });

    const stepId = `step_${ulid()}`;
    await events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'a-step', input: new Uint8Array([4, 5]) },
    });
    await events.create(runId, {
      eventType: 'step_started',
      correlationId: stepId,
    });
    await events.create(runId, {
      eventType: 'step_completed',
      correlationId: stepId,
      eventData: { output: new Uint8Array([6, 7]) },
    });

    const hookId = `hook_${ulid()}`;
    await events.create(runId, {
      eventType: 'hook_created',
      correlationId: hookId,
      eventData: {
        token: `token-${hookId}`,
        metadata: new Uint8Array([8, 9]),
        // Outlives the run, so the terminal transition keeps the row and the
        // purge is the only thing that can clear its metadata.
        tokenRetentionUntil: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const streamId = `stream-${runId}`;
    await streamer.streams.write(runId, streamId, new Uint8Array([10, 11]));
    await streamer.streams.close(runId, streamId);

    // Backfill the legacy JSON twins.
    await pool.query(
      `UPDATE workflow.workflow_runs
          SET input = '["legacy-input"]'::jsonb,
              output = '["legacy-output"]'::jsonb,
              error = 'legacy-error'
        WHERE id = $1`,
      [runId]
    );
    await pool.query(
      `UPDATE workflow.workflow_steps
          SET input = '["legacy-input"]'::jsonb,
              output = '["legacy-output"]'::jsonb,
              error = 'legacy-error'
        WHERE run_id = $1`,
      [runId]
    );
    await pool.query(
      `UPDATE workflow.workflow_events SET payload = '{"legacy":true}'::jsonb WHERE run_id = $1`,
      [runId]
    );
    await pool.query(
      `UPDATE workflow.workflow_hooks
          SET metadata = '["legacy-metadata"]'::jsonb,
              resume_context = '\\x00'::bytea
        WHERE run_id = $1`,
      [runId]
    );

    return { runId, stepId, hookId, streamId };
  }

  /** How many payload columns across the run's rows still hold a value. */
  async function countRemainingPayloads(runId: string): Promise<number> {
    const tables: Array<[string, readonly string[], string]> = [
      ['workflow_runs', PAYLOAD_COLUMNS.runs, 'id'],
      ['workflow_steps', PAYLOAD_COLUMNS.steps, 'run_id'],
      ['workflow_events', PAYLOAD_COLUMNS.events, 'run_id'],
      ['workflow_hooks', PAYLOAD_COLUMNS.hooks, 'run_id'],
    ];
    let total = 0;
    for (const [table, columns, key] of tables) {
      const counts = columns.map((c) => `count("${c}")`).join(' + ');
      const { rows } = await pool.query(
        `SELECT (${counts})::int AS n FROM workflow.${table} WHERE "${key}" = $1`,
        [runId]
      );
      total += rows[0]?.n ?? 0;
    }
    const { rows: chunkRows } = await pool.query(
      `SELECT COALESCE(sum(octet_length(data)), 0)::int AS n
         FROM workflow.workflow_stream_chunks WHERE run_id = $1`,
      [runId]
    );
    return total + (chunkRows[0]?.n ?? 0);
  }

  async function rowCounts(runId: string) {
    const one = async (table: string, key: string) => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM workflow.${table} WHERE "${key}" = $1`,
        [runId]
      );
      return rows[0].n as number;
    };
    return {
      runs: await one('workflow_runs', 'id'),
      steps: await one('workflow_steps', 'run_id'),
      events: await one('workflow_events', 'run_id'),
      hooks: await one('workflow_hooks', 'run_id'),
      chunks: await one('workflow_stream_chunks', 'run_id'),
    };
  }

  describe('$retention: "0"', () => {
    it('nulls every payload column, CBOR and legacy JSON alike, and stamps expiredAt', async () => {
      const { runId, streamId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });

      // Sanity: the fixture really does have data to lose.
      expect(await countRemainingPayloads(runId)).toBeGreaterThan(0);
      const before = await rowCounts(runId);

      await events.create(runId, {
        eventType: 'run_completed',
        eventData: { output: new Uint8Array([12, 13]) },
      });

      expect(await countRemainingPayloads(runId)).toBe(0);

      // The rows themselves stay: a purged run is still listable. The only
      // difference is the terminal event the write just appended.
      expect(await rowCounts(runId)).toEqual({
        ...before,
        events: before.events + 1,
      });

      const { rows } = await pool.query(
        'SELECT expired_at, status, name, attributes, execution_context_cbor FROM workflow.workflow_runs WHERE id = $1',
        [runId]
      );
      expect(rows[0].expired_at).toBeInstanceOf(Date);
      // Metadata is deliberately kept, so a purged run stays traceable.
      expect(rows[0].status).toBe('completed');
      expect(rows[0].name).toBe('retention-workflow');
      expect(rows[0].attributes).toEqual({ [RETENTION_ATTRIBUTE]: '0' });
      expect(rows[0].execution_context_cbor).not.toBeNull();

      // And the run reads back as expired through the World's own API.
      const run = await runs.get(runId);
      expect(run.expiredAt).toBeInstanceOf(Date);
      expect(run.input).toBeUndefined();
      expect(run.output).toBeUndefined();

      // The stream still terminates and is still enumerable; it just has no
      // bytes left.
      expect(await streamer.streams.list(runId)).toEqual([streamId]);
      const chunks = await streamer.streams.getChunks(runId, streamId);
      expect(chunks.done).toBe(true);
      expect(chunks.data.every((c) => c.data.byteLength === 0)).toBe(true);
    });

    it('clears the payload columns to SQL NULL, not a CBOR-encoded null', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await events.create(runId, {
        eventType: 'run_completed',
        eventData: { output: new Uint8Array([12, 13]) },
      });

      const { rows } = await pool.query(
        `SELECT input_cbor IS NULL AS i, output_cbor IS NULL AS o, error_cbor IS NULL AS e
           FROM workflow.workflow_runs WHERE id = $1`,
        [runId]
      );
      expect(rows[0]).toEqual({ i: true, o: true, e: true });
    });

    it('purges on run_failed', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await events.create(runId, {
        eventType: 'run_failed',
        eventData: { error: new Uint8Array([99]), errorCode: 'USER_ERROR' },
      });

      expect(await countRemainingPayloads(runId)).toBe(0);
      const { rows } = await pool.query(
        'SELECT expired_at, error_code FROM workflow.workflow_runs WHERE id = $1',
        [runId]
      );
      expect(rows[0].expired_at).toBeInstanceOf(Date);
      // Plaintext routing metadata, kept like the Vercel World keeps it.
      expect(rows[0].error_code).toBe('USER_ERROR');
    });

    it('purges on run_cancelled', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await events.create(runId, { eventType: 'run_cancelled' });

      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('does not purge before the run reaches a terminal state', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });

      expect(await countRemainingPayloads(runId)).toBeGreaterThan(0);
      const { rows } = await pool.query(
        'SELECT expired_at FROM workflow.workflow_runs WHERE id = $1',
        [runId]
      );
      expect(rows[0].expired_at).toBeNull();
    });
  });

  /**
   * The group that matters. The failure mode worth guarding against is not a
   * purge that does not fire — it is a purge that fires on a value nobody
   * meant as "delete my data".
   */
  describe('every other value keeps the data', () => {
    const cases: Array<[string, Record<string, string> | undefined]> = [
      ['no attribute at all', undefined],
      ['an unrelated attribute', { tenant: 't1' }],
      ['"default"', { [RETENTION_ATTRIBUTE]: 'default' }],
      ['a non-zero duration, "7"', { [RETENTION_ATTRIBUTE]: '7' }],
      ['a large duration, "86400"', { [RETENTION_ATTRIBUTE]: '86400' }],
      ['a malformed value, "none"', { [RETENTION_ATTRIBUTE]: 'none' }],
      ['a negative value, "-1"', { [RETENTION_ATTRIBUTE]: '-1' }],
      ['a float, "0.0"', { [RETENTION_ATTRIBUTE]: '0.0' }],
      ['an empty string', { [RETENTION_ATTRIBUTE]: '' }],
      ['a padded zero, " 0 "', { [RETENTION_ATTRIBUTE]: ' 0 ' }],
      ['a zero with a unit, "0s"', { [RETENTION_ATTRIBUTE]: '0s' }],
    ];

    for (const [label, attributes] of cases) {
      it(`keeps everything for ${label}`, async () => {
        const { runId } = await seedRun(attributes);
        const before = await countRemainingPayloads(runId);
        expect(before).toBeGreaterThan(0);

        await events.create(runId, {
          eventType: 'run_completed',
          eventData: { output: new Uint8Array([12, 13]) },
        });

        // The run_completed output adds a payload; nothing is taken away.
        expect(await countRemainingPayloads(runId)).toBeGreaterThanOrEqual(
          before
        );

        const { rows } = await pool.query(
          'SELECT expired_at, input_cbor, output_cbor FROM workflow.workflow_runs WHERE id = $1',
          [runId]
        );
        expect(rows[0].expired_at).toBeNull();
        expect(rows[0].input_cbor).not.toBeNull();
        expect(rows[0].output_cbor).not.toBeNull();

        const run = await runs.get(runId);
        expect(run.expiredAt).toBeUndefined();
        expect(run.output).toBeDefined();
      });
    }
  });
});
