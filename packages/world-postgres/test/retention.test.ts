import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RunExpiredError } from '@workflow/errors';
import {
  MessageId,
  RETENTION_ATTRIBUTE,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { encode } from 'cbor-x';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils, run as runWorker } from 'graphile-worker';
import { ulid } from 'ulid';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { handleConnectionErrors } from '../src/connection-errors.js';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import { MessageData } from '../src/message.js';
import {
  loadQueueMessage,
  recoverQueueMessages,
  settleQueueMessage,
} from '../src/queue-payloads.js';
import { createSnapshotsStorage } from '../src/snapshots.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  recoverTerminalRequests,
} from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';
import { TestPool } from './pool.js';

type EventsStorage = ReturnType<typeof createEventsStorage>;

/** Every payload-bearing column, CBOR half and legacy JSON twin alike. */
const PAYLOAD_COLUMNS = {
  runs: [
    'input_cbor',
    'input',
    'output_cbor',
    'output',
    'error_cbor',
    'error',
    'dynamic_workflow_code_cbor',
    'execution_context_cbor',
    'execution_context',
  ],
  steps: [
    'input_cbor',
    'input',
    'output_cbor',
    'output',
    'error_cbor',
    'error',
  ],
  events: ['payload_cbor', 'payload', 'resume_payload_digest'],
  hooks: ['metadata_cbor', 'metadata', 'resume_context'],
  invocations: ['payload', 'result', 'fingerprint'],
} as const;

describe('Retention ($retention: 0)', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let drizzle: ReturnType<typeof createClient>;
  let runs: ReturnType<typeof createRunsStorage>;
  let events: EventsStorage;
  let streamer: ReturnType<typeof createStreamer>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;

    pool = new TestPool({ connectionString: dbUrl, max: 4 });
    handleConnectionErrors(pool, () => false);
    drizzle = createClient(pool);
    await migrate(drizzle, {
      migrationsFolder: fileURLToPath(
        new URL('../src/drizzle/migrations', import.meta.url)
      ),
      migrationsTable: 'workflow_migrations',
      migrationsSchema: 'workflow_drizzle',
    });
    runs = createRunsStorage(drizzle);
    events = createEventsStorage(drizzle);
    streamer = createStreamer(pool, drizzle);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`DO $$ BEGIN IF to_regclass('graphile_worker.jobs') IS NOT NULL THEN
      PERFORM graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs));
    END IF; END $$;`);
    await pool.query(
      'TRUNCATE TABLE workflow.workflow_events, workflow.workflow_event_slots, ' +
        'workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_waits, ' +
        'workflow.workflow_queue_payloads, workflow.workflow_snapshots, workflow.workflow_stream_chunks, workflow.workflow_invocations, workflow.workflow_runs ' +
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
        // A dynamic run's stored code is a run payload too, and the only one
        // that lives in a column of its own.
        dynamicWorkflowCode: new Uint8Array([14, 15, 16]),
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
      eventData: { result: new Uint8Array([6, 7]) },
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
    await createSnapshotsStorage(drizzle).save(
      runId,
      new Uint8Array([17, 18]),
      {
        eventsCursor: null,
        createdAt: new Date(),
      }
    );

    // Backfill the legacy JSON twins.
    await pool.query(
      `UPDATE workflow.workflow_runs
          SET input = '["legacy-input"]'::jsonb,
              output = '["legacy-output"]'::jsonb,
              error = 'legacy-error',
              execution_context = '{"legacyUserId":"legacy-user"}'::jsonb
        WHERE id = $1`,
      [runId]
    );
    await pool.query(
      `UPDATE workflow.workflow_steps
          SET input = '["legacy-input"]'::jsonb,
              output = '["legacy-output"]'::jsonb,
              error = 'legacy-error',
              error_cbor = $2
        WHERE run_id = $1`,
      [runId, encode(new Uint8Array([19, 20]))]
    );
    await pool.query(
      `UPDATE workflow.workflow_events SET payload = '{"legacy":true}'::jsonb,
        resume_payload_digest = 'synthetic-resume-digest' WHERE run_id = $1`,
      [runId]
    );
    await pool.query(
      `UPDATE workflow.workflow_hooks
          SET metadata = '["legacy-metadata"]'::jsonb,
              resume_context = '\\x00'::bytea
        WHERE run_id = $1`,
      [runId]
    );
    await pool.query(
      `INSERT INTO workflow.workflow_invocations(run_id, request_id, payload, result, fingerprint, responded_at)
       VALUES ($1, 'retention-fixture', $2, $3, 'fingerprint', now())`,
      [runId, Buffer.from([12]), Buffer.from([13])]
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
      ['workflow_invocations', PAYLOAD_COLUMNS.invocations, 'run_id'],
      ['workflow_snapshots', ['data'], 'run_id'],
      ['workflow_queue_payloads', ['data'], 'run_id'],
      ['workflow_terminal_requests', ['request'], 'run_id'],
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

  async function seedEveryPayloadColumn(runId: string) {
    await pool.query(
      'UPDATE workflow.workflow_runs SET output_cbor = $2, error_cbor = $3 WHERE id = $1',
      [runId, encode(new Uint8Array([21])), encode(new Uint8Array([22]))]
    );
    const populated = new Map<string, Record<string, unknown>>();
    for (const [table, columns] of Object.entries(PAYLOAD_COLUMNS)) {
      const key = table === 'runs' ? 'id' : 'run_id';
      const { rows } = await pool.query(
        `SELECT ${columns.join(', ')} FROM workflow.workflow_${table} WHERE ${key} = $1`,
        [runId]
      );
      for (const column of columns) {
        expect(
          rows.some((row) => row[column] !== null),
          `${table}.${column} is seeded`
        ).toBe(true);
      }
      populated.set(table, rows[0]);
    }
    return populated;
  }

  async function assertPayloadOmissionsAreDetected(
    runId: string,
    populated: Map<string, Record<string, unknown>>
  ) {
    // Positive controls: leaving any one claimed column behind must make
    // the aggregate deletion oracle fail, including legacy-only values.
    for (const [table, columns] of Object.entries(PAYLOAD_COLUMNS)) {
      const key = table === 'runs' ? 'id' : 'run_id';
      for (const column of columns) {
        const value = populated.get(table)?.[column];
        const restored = await pool.query(
          `UPDATE workflow.workflow_${table} SET ${column} = $2 WHERE ${key} = $1`,
          [
            runId,
            typeof value === 'object' && !Buffer.isBuffer(value)
              ? JSON.stringify(value)
              : value,
          ]
        );
        expect(
          await countRemainingPayloads(runId),
          `${table}.${column} omission is detected`
        ).toBe(restored.rowCount);
        await pool.query(
          `UPDATE workflow.workflow_${table} SET ${column} = NULL WHERE ${key} = $1`,
          [runId]
        );
      }
    }
  }

  async function preservedPayloads(runId: string) {
    const result: Record<string, unknown[]> = {};
    const tables: Array<[string, readonly string[], string]> = [
      [
        'workflow_runs',
        PAYLOAD_COLUMNS.runs.filter((c) => c !== 'output_cbor'),
        'id',
      ],
      ['workflow_steps', PAYLOAD_COLUMNS.steps, 'run_id'],
      ['workflow_events', PAYLOAD_COLUMNS.events, 'run_id'],
      ['workflow_hooks', PAYLOAD_COLUMNS.hooks, 'run_id'],
      ['workflow_invocations', PAYLOAD_COLUMNS.invocations, 'run_id'],
      ['workflow_snapshots', ['data'], 'run_id'],
      ['workflow_stream_chunks', ['data', 'eof'], 'run_id'],
    ];
    for (const [table, columns, key] of tables) {
      // Compare physical values: legacy fixture columns need not satisfy the
      // current API schema, and a new terminal event/output must not mask loss.
      const { rows } = await pool.query(
        `SELECT * FROM (SELECT ${columns.join(', ')} FROM workflow.${table}
          WHERE "${key}" = $1 ${table === 'workflow_events' ? "AND type <> 'run_completed'" : ''}) payloads
          ORDER BY to_jsonb(payloads)::text`,
        [runId]
      );
      result[table] = rows;
    }
    return result;
  }

  describe('$retention: "0"', () => {
    it('rejects malformed queue input before storing an unowned payload', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      try {
        const malformed = {
          runId,
          input: 'malformed-sensitive-input',
          runInput: {},
        } as unknown as Parameters<typeof world.queue>[1];
        await expect(
          world.queue('__wkf_workflow_retention-workflow', malformed)
        ).rejects.toMatchObject({ code: 'QUEUE_MESSAGE_INVALID', status: 400 });
        expect(
          (
            await pool.query(
              'SELECT count(data)::int AS n FROM workflow.workflow_queue_payloads'
            )
          ).rows[0].n
        ).toBe(0);
        await events.create(runId, { eventType: 'run_cancelled' });
        expect(await countRemainingPayloads(runId)).toBe(0);
      } finally {
        await world.close();
      }
    });

    it('keeps cancellation idempotent after expiry without appending payloads', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await events.create(runId, { eventType: 'run_cancelled' });
      const before = await rowCounts(runId);
      expect(
        (await events.create(runId, { eventType: 'run_cancelled' })).run?.status
      ).toBe('cancelled');
      expect(await rowCounts(runId)).toEqual(before);
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('applies the same deletion path when cancelling a waiting run at its domain deadline', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await events.create(runId, {
        eventType: 'wait_created',
        correlationId: 'original-domain-deadline',
        eventData: { resumeAt: new Date(Date.now() + 3600_000) },
      });
      await events.create(runId, { eventType: 'run_cancelled' });
      expect(await countRemainingPayloads(runId)).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM workflow.workflow_waits WHERE run_id = $1',
            [runId]
          )
        ).rows[0].n
      ).toBe(0);
    });

    it.each([
      '0 hours',
      '5 hours',
    ])('withholds restored legacy copies with a %s old lock until safely quiesced', async (age) => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await pool.query(
        `UPDATE workflow.workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
        [runId]
      );
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      const job = await utils.addJob(
        'workflow_flows',
        MessageData.encode({
          id: 'retention-workflow',
          messageId: MessageId.parse(`msg_${ulid()}`),
          attempt: 1,
          data: Buffer.from(
            JSON.stringify({ runId, input: 'restored-sensitive-queue-copy' })
          ),
        })
      );
      await utils.release();
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET locked_by = 'owned-test-legacy-worker', locked_at = now() - $2::interval WHERE id = $1`,
        [job.id, age]
      );
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      try {
        await expect(world.runs.get(runId)).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
        });
        const locked = await pool.query(
          'SELECT locked_by FROM graphile_worker.jobs WHERE id = $1',
          [job.id]
        );
        expect(locked.rows[0].locked_by).toBe('owned-test-legacy-worker');
        // This synthetic worker never ran; only its exact fixture row is unlocked.
        await pool.query(
          'UPDATE graphile_worker._private_jobs SET locked_by = NULL, locked_at = NULL WHERE id = $1',
          [job.id]
        );
        expect((await world.runs.get(runId)).expiredAt).toBeInstanceOf(Date);
        expect(
          (
            await pool.query(
              'SELECT id FROM graphile_worker.jobs WHERE id = $1',
              [job.id]
            )
          ).rows
        ).toHaveLength(0);
        expect(await countRemainingPayloads(runId)).toBe(0);
      } finally {
        await world.close();
      }
    });

    it.each([
      'completed',
      'failed',
      'cancelled',
    ] as const)('removes queued copies of run input when %s', async (status) => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      const marker = 'synthetic-queue-payload-retention-marker';
      const key = `retention-queue-${runId}`;
      try {
        const queued = await world.queue(
          '__wkf_workflow_retention-workflow',
          {
            runId,
            runInput: {
              deploymentId: 'deployment-1',
              workflowName: 'retention-workflow',
              input: marker,
              specVersion: SPEC_VERSION_CURRENT,
            },
          },
          {
            delaySeconds: 3600,
            idempotencyKey: key,
            headers: { 'x-private-context': marker },
          }
        );
        const before = await pool.query(
          `SELECT id, key, payload FROM graphile_worker._private_jobs WHERE payload->>'messageId' = $1`,
          [queued.messageId]
        );
        expect(before.rows).toHaveLength(1);
        expect(JSON.stringify(before.rows[0])).not.toContain(marker);
        expect(before.rows[0].key).not.toBe(key);
        const native = await pool.query(
          'SELECT data FROM workflow.workflow_queue_payloads WHERE job_id = $1',
          [before.rows[0].id]
        );
        expect(
          Buffer.from(
            JSON.parse(native.rows[0].data.toString()).data,
            'base64'
          ).toString()
        ).toContain(marker);
        if (status === 'completed')
          await events.create(runId, {
            eventType: 'run_completed',
            eventData: { output: marker },
          });
        else if (status === 'failed')
          await events.create(runId, {
            eventType: 'run_failed',
            eventData: {
              error: new TextEncoder().encode(marker),
              errorCode: 'USER_ERROR',
            },
          });
        else await events.create(runId, { eventType: 'run_cancelled' });
        // Physical storage is the oracle; the public jobs view intentionally
        // omits payloads and cannot establish that queue copies were deleted.
        const { rows } = await pool.query(
          `SELECT payload FROM graphile_worker._private_jobs WHERE payload->>'messageId' = $1`,
          [queued.messageId]
        );
        const stored = rows
          .map((row) => Buffer.from(row.payload.data, 'base64').toString())
          .join('');
        expect(stored).not.toContain(marker);
        const remaining = await pool.query(
          'SELECT count(data)::int AS n FROM workflow.workflow_queue_payloads WHERE run_id = $1',
          [runId]
        );
        expect(remaining.rows[0].n).toBe(0);
      } finally {
        await world.close();
      }
    });

    it('purges an active queue payload and refuses a late reschedule without repeating delivery', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const accepted = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let deliveries = 0;
      const server = createServer(async (request, response) => {
        await request.toArray();
        deliveries++;
        accepted.resolve();
        await released.promise;
        response.end(JSON.stringify({ timeoutSeconds: 0 }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP server');
      const previous = process.env.WORKFLOW_LOCAL_BASE_URL;
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      try {
        const queued = await world.queue('__wkf_workflow_retention-workflow', {
          runId,
          input: 'active-queue-secret',
        });
        await accepted.promise;
        const job = await pool.query(
          `SELECT id, payload FROM graphile_worker._private_jobs WHERE payload->>'messageId' = $1`,
          [queued.messageId]
        );
        expect(job.rows).toHaveLength(1);
        await events.create(runId, { eventType: 'run_cancelled' });
        expect(await countRemainingPayloads(runId)).toBe(0);
        expect(JSON.stringify(job.rows)).not.toContain('active-queue-secret');
        released.resolve();
        await expect
          .poll(
            async () =>
              (
                await pool.query(
                  'SELECT id FROM graphile_worker.jobs WHERE id = $1',
                  [job.rows[0].id]
                )
              ).rowCount
          )
          .toBe(0);
        expect(deliveries).toBe(1);
        expect(await countRemainingPayloads(runId)).toBe(0);
      } finally {
        released.resolve();
        await world.close();
        if (previous === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
        else process.env.WORKFLOW_LOCAL_BASE_URL = previous;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('persists a content-free settled queue receipt for subsequent database loads', async () => {
      const { runId } = await seedRun();
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      try {
        const queued = await world.queue(
          '__wkf_workflow_retention-workflow',
          { runId },
          { delaySeconds: 3600 }
        );
        const { rows } = await pool.query(
          `SELECT id, payload FROM graphile_worker._private_jobs WHERE payload->>'messageId' = $1`,
          [queued.messageId]
        );
        const reference = MessageData.parse(rows[0].payload);
        expect(
          await loadQueueMessage(drizzle, rows[0].id, reference)
        ).not.toBeNull();
        await settleQueueMessage(drizzle, rows[0].id);
        expect(
          await loadQueueMessage(createClient(pool), rows[0].id, reference)
        ).toBeNull();
        expect(await countRemainingPayloads(runId)).toBeGreaterThan(0);
        const remaining = await pool.query(
          'SELECT data, completed_at FROM workflow.workflow_queue_payloads WHERE job_id = $1',
          [rows[0].id]
        );
        expect(remaining.rows[0].data).toBeNull();
        expect(remaining.rows[0].completed_at).toBeInstanceOf(Date);
      } finally {
        await world.close();
      }
    });

    it('converts restored legacy queue payloads transactionally before opening inspection', async () => {
      const { runId } = await seedRun();
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      const marker = 'legacy-queue-sensitive-payload';
      const message = {
        id: 'retention-workflow',
        messageId: MessageId.parse(`msg_${ulid()}`),
        attempt: 1,
        data: Buffer.from(JSON.stringify({ runId, input: marker })),
      };
      const job = await utils.addJob(
        'workflow_flows',
        MessageData.encode(message),
        {
          jobKey: marker,
          runAt: new Date(Date.now() + 3600_000),
          priority: 7,
          flags: ['retention-fixture'],
        }
      );
      await pool.query(
        'SELECT graphile_worker.permanently_fail_jobs(ARRAY[$1]::bigint[], $2)',
        [job.id, marker]
      );
      await utils.release();
      await pool.query(
        `CREATE FUNCTION workflow.fail_queue_conversion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'conversion failed'; END $$; CREATE TRIGGER fail_queue_conversion BEFORE INSERT ON workflow.workflow_queue_payloads FOR EACH ROW EXECUTE FUNCTION workflow.fail_queue_conversion()`
      );
      try {
        await expect(recoverQueueMessages(drizzle)).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
        });
        expect(
          (
            await pool.query(
              'SELECT id FROM graphile_worker.jobs WHERE id = $1',
              [job.id]
            )
          ).rows
        ).toHaveLength(1);
      } finally {
        await pool.query(
          'DROP TRIGGER fail_queue_conversion ON workflow.workflow_queue_payloads; DROP FUNCTION workflow.fail_queue_conversion()'
        );
      }
      await recoverQueueMessages(drizzle);
      const jobs = await pool.query(
        `SELECT id, payload, key, last_error, attempts, max_attempts, run_at, priority, flags FROM graphile_worker._private_jobs WHERE payload->>'messageId' = $1`,
        [message.messageId]
      );
      expect(jobs.rows).toHaveLength(1);
      expect(JSON.stringify(jobs.rows)).not.toContain(marker);
      expect(jobs.rows[0].attempts).toBe(jobs.rows[0].max_attempts);
      expect(jobs.rows[0].run_at).toEqual(job.run_at);
      expect(jobs.rows[0].priority).toBe(7);
      expect(jobs.rows[0].flags).toEqual({ 'retention-fixture': true });
      expect(
        (
          await loadQueueMessage(
            drizzle,
            jobs.rows[0].id,
            MessageData.parse(jobs.rows[0].payload)
          )
        )?.data.toString()
      ).toContain(marker);
    });

    it('converts a runnable legacy job after real failures without resetting its retry budget or offsets', async () => {
      const { runId } = await seedRun();
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      const message = {
        id: 'retention-workflow',
        messageId: MessageId.parse(`msg_${ulid()}`),
        attempt: 5,
        attemptOffset: 4,
        deliveryOffset: 8,
        data: Buffer.from(JSON.stringify({ runId, input: 'retry-fixture' })),
      };
      const job = await utils.addJob(
        'workflow_flows',
        MessageData.encode(message),
        {
          maxAttempts: 9,
          queueName: 'legacy-retry-queue',
          priority: 6,
          flags: ['legacy-retry'],
        }
      );
      const runner = await runWorker({
        pgPool: pool,
        concurrency: 1,
        noHandleSignals: true,
        pollInterval: 50,
        taskList: {
          workflow_flows: async () => {
            throw new Error('synthetic retry failure');
          },
        },
      });
      try {
        await expect
          .poll(
            async () => {
              const { rows } = await pool.query(
                'SELECT attempts, locked_at, last_error FROM graphile_worker.jobs WHERE id = $1',
                [job.id]
              );
              return rows[0];
            },
            { timeout: 30_000 }
          )
          .toMatchObject({
            attempts: 3,
            locked_at: null,
            last_error: 'synthetic retry failure',
          });
      } finally {
        await runner.stop();
        await utils.release();
      }
      const before = (
        await pool.query('SELECT * FROM graphile_worker.jobs WHERE id = $1', [
          job.id,
        ])
      ).rows[0];
      expect(before.attempts).toBe(3);
      expect(before.max_attempts).toBe(9);

      await recoverQueueMessages(drizzle);

      const converted = (
        await pool.query(
          `SELECT j.*, p.payload FROM graphile_worker.jobs j JOIN graphile_worker._private_jobs p USING (id)
         WHERE p.payload->>'messageId' = $1`,
          [message.messageId]
        )
      ).rows;
      expect(converted).toHaveLength(1);
      expect(converted[0]).toMatchObject({
        attempts: 0,
        max_attempts: 6,
        run_at: before.run_at,
        queue_name: 'legacy-retry-queue',
        priority: 6,
        flags: { 'legacy-retry': true },
      });
      const hydrated = await loadQueueMessage(
        drizzle,
        converted[0].id,
        MessageData.parse(converted[0].payload)
      );
      expect(hydrated).toMatchObject({
        attempt: 5,
        attemptOffset: 7,
        deliveryOffset: 11,
      });
      expect(hydrated?.data).toEqual(message.data);
    });

    it('withholds readiness for a malformed legacy job and leaves its batch intact', async () => {
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      const job = await utils.addJob(
        'workflow_flows',
        { malformed: 'synthetic-input' },
        {
          runAt: new Date(Date.now() + 3600_000),
        }
      );
      await utils.release();
      const world = createWorld({ pool, applicationManagedShutdown: true });
      try {
        await expect(world.start()).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
          status: 503,
        });
        const remaining = await pool.query(
          'SELECT payload FROM graphile_worker._private_jobs WHERE id = $1',
          [job.id]
        );
        expect(remaining.rows).toEqual([
          { payload: { malformed: 'synthetic-input' } },
        ]);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM workflow.workflow_queue_payloads'
            )
          ).rows[0].n
        ).toBe(0);
      } finally {
        await world.close();
      }
    });

    it('converts every legacy job across the 100-job recovery batch boundary', async () => {
      const { runId } = await seedRun();
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      const messages = Array.from({ length: 101 }, (_, index) => ({
        id: 'retention-workflow',
        messageId: MessageId.parse(`msg_${ulid()}`),
        attempt: 1,
        data: Buffer.from(
          JSON.stringify({ runId, input: `batch-fixture-${index}` })
        ),
      }));
      try {
        for (const message of messages) {
          await utils.addJob('workflow_flows', MessageData.encode(message), {
            runAt: new Date(Date.now() + 3600_000),
          });
        }
      } finally {
        await utils.release();
      }

      await recoverQueueMessages(drizzle);

      const { rows } = await pool.query(
        `SELECT id, payload FROM graphile_worker._private_jobs WHERE payload->>'messageId' = ANY($1::text[])`,
        [messages.map((message) => message.messageId)]
      );
      expect(rows).toHaveLength(101);
      expect(JSON.stringify(rows)).not.toContain('batch-fixture-');
      const originals = new Map(
        messages.map((message) => [message.messageId, message])
      );
      for (const row of rows) {
        const reference = MessageData.parse(row.payload);
        expect(reference.payloadVersion).toBe(1);
        const hydrated = await loadQueueMessage(drizzle, row.id, reference);
        expect(hydrated?.data).toEqual(
          originals.get(reference.messageId)?.data
        );
      }
      expect(
        (
          await pool.query(
            'SELECT count(data)::int AS n FROM workflow.workflow_queue_payloads WHERE run_id = $1',
            [runId]
          )
        ).rows[0].n
      ).toBe(101);
    });

    it('finishes an open stream after cancellation without exposing purged bytes', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await streamer.streams.write(runId, 'open-stream', 'active-content');
      const reader = (
        await streamer.streams.get(runId, 'open-stream')
      ).getReader();
      expect((await reader.read()).value).toEqual(
        new TextEncoder().encode('active-content')
      );
      await events.create(runId, { eventType: 'run_cancelled' });
      await streamer.streams.close(runId, 'open-stream');
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('orders reciprocal hook force-claims without a run-lock deadlock', async () => {
      const a = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const b = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await Promise.all([
        events.create(a.runId, {
          eventType: 'hook_created',
          correlationId: `hook_${ulid()}`,
          eventData: { token: `token-${b.hookId}`, force: true },
        }),
        events.create(b.runId, {
          eventType: 'hook_created',
          correlationId: `hook_${ulid()}`,
          eventData: { token: `token-${a.hookId}`, force: true },
        }),
      ]);
      const hooks = createHooksStorage(drizzle);
      expect((await hooks.getByToken(`token-${b.hookId}`)).runId).toBe(a.runId);
      expect((await hooks.getByToken(`token-${a.hookId}`)).runId).toBe(b.runId);
    });

    it('includes an in-flight default-policy writer when retention switches to zero', async () => {
      const { runId } = await seedRun();
      const blocker = await pool.connect();
      await blocker.query('SELECT pg_advisory_lock(391)');
      await pool.query(`
        CREATE FUNCTION workflow.pause_retention_writer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(391); RETURN NEW; END $$;
        CREATE TRIGGER pause_retention_writer BEFORE INSERT ON workflow.workflow_stream_chunks
        FOR EACH ROW EXECUTE FUNCTION workflow.pause_retention_writer();
      `);
      const writer = streamer.streams.write(
        runId,
        'policy-race',
        'late-sensitive-content'
      );
      let terminalDone = false;
      let terminal: Promise<void> | undefined;
      try {
        await expect
          .poll(async () => {
            const { rows } = await pool.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
            );
            return rows[0].n;
          })
          .toBe(1);
        terminal = (async () => {
          await runs.experimentalSetAttributes!(
            runId,
            [{ key: RETENTION_ATTRIBUTE, value: '0' }],
            { allowReservedAttributes: true }
          );
          await events.create(runId, { eventType: 'run_cancelled' });
          terminalDone = true;
        })();
        await expect
          .poll(async () => {
            const { rows } = await pool.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
            );
            return terminalDone || rows[0].n > 1;
          })
          .toBe(true);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock(391)');
        blocker.release();
        await writer;
        await terminal;
        await pool.query(
          `DROP TRIGGER pause_retention_writer ON workflow.workflow_stream_chunks; DROP FUNCTION workflow.pause_retention_writer()`
        );
      }
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('rolls back a database disconnect between the terminal update and purge commit', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await pool.query(`
        CREATE FUNCTION workflow.crash_retention_purge() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
        CREATE TRIGGER crash_retention_purge BEFORE UPDATE ON workflow.workflow_steps
        FOR EACH ROW EXECUTE FUNCTION workflow.crash_retention_purge();
      `);
      try {
        await expect(
          events.create(runId, { eventType: 'run_cancelled' })
        ).rejects.toMatchObject({ code: 'RETENTION_CLEANUP_FAILED' });
        const state = await pool.query(
          'SELECT status FROM workflow.workflow_runs WHERE id = $1',
          [runId]
        );
        expect(state.rows[0].status).toBe('running');
      } finally {
        await pool.query(
          `DROP TRIGGER crash_retention_purge ON workflow.workflow_steps; DROP FUNCTION workflow.crash_retention_purge()`
        );
      }
      await createEventsStorage(createClient(pool)).create(runId, {
        eventType: 'run_cancelled',
      });
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it.each([
      'stream',
      'snapshot',
      'event',
    ] as const)('serializes a concurrent %s writer with expiry', async (kind) => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM workflow.workflow_runs WHERE id = $1 FOR UPDATE',
        [runId]
      );
      const write = () =>
        kind === 'stream'
          ? streamer.streams.write(runId, 'racing-stream', 'late-content')
          : kind === 'snapshot'
            ? createSnapshotsStorage(drizzle).save(
                runId,
                new Uint8Array([99]),
                { eventsCursor: null, createdAt: new Date() }
              )
            : events.create(runId, {
                eventType: 'step_created',
                correlationId: `step_${ulid()}`,
                eventData: {
                  stepName: 'racing-step',
                  input: new Uint8Array([99]),
                },
              });
      // Attach rejection handlers immediately; both operations are parked on
      // the real run lock before the barrier is released.
      const writer = Promise.allSettled([write()]);
      let terminal: Promise<unknown> | undefined;
      try {
        await expect
          .poll(async () => {
            const { rows } = await pool.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
            );
            return rows[0].n;
          })
          .toBeGreaterThan(0);
        terminal = events.create(runId, { eventType: 'run_cancelled' });
        await expect
          .poll(async () => {
            const { rows } = await pool.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
            );
            return rows[0].n;
          })
          .toBeGreaterThan(1);
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }
      const [outcome] = await writer;
      expect(outcome.status).toBe('fulfilled');
      await terminal;
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('cleans restored terminal payloads before starting workers and fails closed until cleanup recovers', async () => {
      const { runId, stepId, hookId, streamId } = await seedRun({
        [RETENTION_ATTRIBUTE]: '0',
      });
      // Reproduce a backup from the old terminal-commit/purge crash window.
      await pool.query(
        `UPDATE workflow.workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
        [runId]
      );
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      await pool.query(`
        CREATE FUNCTION workflow.fail_retention_purge() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'sensitive database error'; END $$;
        CREATE TRIGGER fail_retention_purge BEFORE UPDATE ON workflow.workflow_steps
        FOR EACH ROW EXECUTE FUNCTION workflow.fail_retention_purge();
      `);
      try {
        const inspection = [
          () => world.runs.get(runId),
          () => world.events.list({ runId }),
          () => world.steps.get(runId, stepId),
          () => world.hooks.get(hookId),
          () => world.experimental_snapshots!.load(runId),
          () => world.streams.getChunks(runId, streamId),
          () => world.streams.get(runId, streamId),
        ];
        for (const read of inspection) {
          await expect(read()).rejects.toMatchObject({
            code: 'RETENTION_CLEANUP_FAILED',
            status: 503,
          });
        }
        await expect(world.start()).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
          status: 503,
        });
        await expect(world.runs.get(runId)).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
        });
        expect(await countRemainingPayloads(runId)).toBeGreaterThan(0);
      } finally {
        await pool.query(
          `DROP TRIGGER fail_retention_purge ON workflow.workflow_steps; DROP FUNCTION workflow.fail_retention_purge()`
        );
        await world.close();
      }
      const restarted = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      try {
        await restarted.start();
        expect(await countRemainingPayloads(runId)).toBe(0);
      } finally {
        await restarted.close();
      }
    });

    it('withholds inspection and admission after a live deletion failure until recovery succeeds', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const world = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      const fresh = createWorld({
        pool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      });
      await events.create(runId, {
        eventType: 'wait_created',
        correlationId: 'live-failure-wait',
        eventData: { resumeAt: new Date(Date.now() + 3600_000) },
      });
      // Establish readiness before the failure, rather than testing startup only.
      expect(await world.experimental_snapshots!.load(runId)).not.toBeNull();
      await pool.query(`
        CREATE FUNCTION workflow.fail_live_retention() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'sensitive live purge failure'; END $$;
        CREATE TRIGGER fail_live_retention BEFORE UPDATE ON workflow.workflow_steps
        FOR EACH ROW EXECUTE FUNCTION workflow.fail_live_retention();
      `);
      try {
        try {
          await expect(
            world.events.create(runId, { eventType: 'run_cancelled' })
          ).rejects.toMatchObject({ code: 'RETENTION_CLEANUP_FAILED' });
          expect(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM workflow.workflow_terminal_requests WHERE run_id = $1 AND octet_length(request) > 0',
                [runId]
              )
            ).rows[0].n
          ).toBe(1);
          await expect(
            world.experimental_snapshots!.load(runId)
          ).rejects.toMatchObject({
            code: 'RETENTION_CLEANUP_FAILED',
          });
          await expect(
            world.queue('__wkf_workflow_retention-workflow', { runId })
          ).rejects.toMatchObject({ code: 'RETENTION_CLEANUP_FAILED' });
          await expect(
            fresh.experimental_snapshots!.load(runId)
          ).rejects.toMatchObject({
            code: 'RETENTION_CLEANUP_FAILED',
          });
          await expect(fresh.start()).rejects.toMatchObject({
            code: 'RETENTION_CLEANUP_FAILED',
          });
          await expect(
            fresh.events.create(null, {
              eventType: 'run_created',
              eventData: {
                deploymentId: 'postgres',
                workflowName: 'new-affected-work',
                input: new Uint8Array([42]),
              },
            })
          ).rejects.toMatchObject({ code: 'RETENTION_CLEANUP_FAILED' });
          expect(await countRemainingPayloads(runId)).toBeGreaterThan(0);
        } finally {
          await pool.query(
            `DROP TRIGGER fail_live_retention ON workflow.workflow_steps; DROP FUNCTION workflow.fail_live_retention()`
          );
        }
        await fresh.start();
        expect((await fresh.runs.get(runId)).status).toBe('cancelled');
        expect(await countRemainingPayloads(runId)).toBe(0);
        expect(await world.experimental_snapshots!.load(runId)).toBeNull();
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM workflow.workflow_waits WHERE run_id = $1',
              [runId]
            )
          ).rows[0].n
        ).toBe(0);
        const admitted = await fresh.events.create(null, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'postgres',
            workflowName: 'new-affected-work',
            input: new Uint8Array([42]),
          },
        });
        expect(admitted.run?.status).toBe('pending');
      } finally {
        await fresh.close();
        await world.close();
      }
    });

    it('keeps terminal-intent storage failures content-free', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await pool.query(`
        CREATE FUNCTION workflow.fail_terminal_intent() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'sensitive terminal intent failure'; END $$;
        CREATE TRIGGER fail_terminal_intent BEFORE INSERT ON workflow.workflow_terminal_requests
        FOR EACH ROW EXECUTE FUNCTION workflow.fail_terminal_intent();
      `);
      try {
        await expect(
          events.create(runId, { eventType: 'run_cancelled' })
        ).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
          status: 503,
        });
      } finally {
        await pool.query(
          'DROP TRIGGER fail_terminal_intent ON workflow.workflow_terminal_requests; DROP FUNCTION workflow.fail_terminal_intent()'
        );
      }
    });

    it.each([
      1.5, 2147483648,
    ])('rejects a terminal spec version %s before retaining its request', async (specVersion) => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await expect(
        events.create(runId, { eventType: 'run_cancelled', specVersion })
      ).rejects.toMatchObject({ status: 400 });
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM workflow.workflow_terminal_requests WHERE run_id = $1',
            [runId]
          )
        ).rows[0].n
      ).toBe(0);
      await events.create(runId, { eventType: 'run_cancelled' });
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('bounds pending-request recovery query failures', async () => {
      const query = vi
        .spyOn(pool, 'query')
        .mockRejectedValueOnce(
          new Error('sensitive recovery database failure')
        );
      try {
        await expect(recoverTerminalRequests(drizzle)).rejects.toMatchObject({
          code: 'RETENTION_CLEANUP_FAILED',
          status: 503,
        });
      } finally {
        query.mockRestore();
      }
    });

    it('does not retain a terminal request rejected by the in-band fence', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await expect(
        events.create(
          runId,
          { eventType: 'run_cancelled' },
          {
            inBand: true,
            expectedSeqInBand: 9999,
          }
        )
      ).rejects.toMatchObject({ name: 'InBandSupersededError' });
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM workflow.workflow_terminal_requests WHERE run_id = $1',
            [runId]
          )
        ).rows[0].n
      ).toBe(0);
      const world = createWorld({ pool, applicationManagedShutdown: true });
      try {
        expect(await world.experimental_snapshots!.load(runId)).not.toBeNull();
      } finally {
        await world.close();
      }
    });

    it('rejects snapshot recreation after expiry', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const snapshots = createSnapshotsStorage(drizzle);
      await events.create(runId, { eventType: 'run_cancelled' });
      expect(await snapshots.load(runId)).toBeNull();
      await expect(
        snapshots.save(runId, new Uint8Array([99]), {
          eventsCursor: null,
          createdAt: new Date(),
        })
      ).rejects.toBeInstanceOf(RunExpiredError);
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('rolls back terminal delivery when deletion fails, then recovers on redelivery after restart', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await pool.query(`
        CREATE FUNCTION workflow.fail_retention_purge() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected purge failure'; END $$;
        CREATE TRIGGER fail_retention_purge BEFORE UPDATE ON workflow.workflow_steps
        FOR EACH ROW EXECUTE FUNCTION workflow.fail_retention_purge();
      `);
      const terminal = {
        eventType: 'run_completed' as const,
        eventData: { output: new Uint8Array([12, 13]) },
      };
      try {
        await expect(events.create(runId, terminal)).rejects.toThrow();
        const state = await pool.query(
          'SELECT status FROM workflow.workflow_runs WHERE id = $1',
          [runId]
        );
        expect(state.rows[0].status).toBe('running');
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM workflow.workflow_events WHERE run_id = $1 AND type = 'run_completed'`,
          [runId]
        );
        expect(rows[0].n).toBe(0);
      } finally {
        await pool.query(
          `DROP TRIGGER fail_retention_purge ON workflow.workflow_steps; DROP FUNCTION workflow.fail_retention_purge()`
        );
      }
      const restartedEvents = createEventsStorage(createClient(pool));
      await restartedEvents.create(runId, terminal);
      expect((await runs.get(runId)).status).toBe('completed');
      expect(await countRemainingPayloads(runId)).toBe(0);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM workflow.workflow_events WHERE run_id = $1 AND type = 'step_completed'`,
        [runId]
      );
      expect(rows[0].n).toBe(1);
    });

    it.each([
      'write',
      'writeMulti',
    ] as const)('rejects a late stream %s without storing bytes', async (method) => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      await events.create(runId, { eventType: 'run_cancelled' });
      const write =
        method === 'write'
          ? streamer.streams.write(runId, 'late-stream', 'sensitive-late-data')
          : streamer.streams.writeMulti(runId, 'late-stream', [
              'sensitive-late-data',
            ]);
      await expect(write).rejects.toBeInstanceOf(RunExpiredError);
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('rejects late step payloads after cancellation', async () => {
      const { runId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const stepId = `step_${ulid()}`;
      await events.create(runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'in-flight', input: new Uint8Array([1]) },
      });
      await events.create(runId, {
        eventType: 'step_started',
        correlationId: stepId,
      });
      await events.create(runId, { eventType: 'run_cancelled' });
      await expect(
        events.create(runId, {
          eventType: 'step_completed',
          correlationId: stepId,
          eventData: { result: new Uint8Array([99]) },
        })
      ).rejects.toBeInstanceOf(RunExpiredError);
      expect(await countRemainingPayloads(runId)).toBe(0);
    });

    it('nulls every payload column, CBOR and legacy JSON alike, and stamps expiredAt', async () => {
      const { runId, streamId } = await seedRun({ [RETENTION_ATTRIBUTE]: '0' });
      const populated = await seedEveryPayloadColumn(runId);
      const before = await rowCounts(runId);

      await events.create(runId, {
        eventType: 'run_completed',
        eventData: { output: new Uint8Array([12, 13]) },
      });

      expect(await countRemainingPayloads(runId)).toBe(0);

      await assertPayloadOmissionsAreDetected(runId, populated);

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
      expect(rows[0].execution_context_cbor).toBeNull();

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
        const before = await preservedPayloads(runId);

        await events.create(runId, {
          eventType: 'run_completed',
          eventData: { output: new Uint8Array([12, 13]) },
        });

        expect(await preservedPayloads(runId)).toEqual(before);

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
