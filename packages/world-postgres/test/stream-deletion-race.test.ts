import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RETENTION_ATTRIBUTE } from '@workflow/world';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createEventsStorage, createRunsStorage } from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';
import { TestPool } from './pool.js';

/** Runs raced per mode. */
const ITERATIONS = Number(process.env.STREAM_DELETION_RACE_ITERATIONS ?? 25);
/** Concurrent stream writers per run. */
const WRITERS = 3;
/** How long each run is watched for bytes after its deletion returned. */
const WATCH_MS = 40;

/**
 * Stream writes racing a run's finish and the deletion of its data, at
 * random offsets. Once the deletion has returned, no chunk of the run may
 * hold bytes, not even for a moment, whether read from the table or through
 * the World. `tla/StreamPurge.tla` models the same race.
 */
describe('stream writes racing data deletion', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let runs: ReturnType<typeof createRunsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
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

    pool = new TestPool({ connectionString: dbUrl, max: 12 });
    const drizzle = createClient(pool);
    runs = createRunsStorage(drizzle);
    events = createEventsStorage(drizzle);
    streamer = createStreamer(pool, drizzle);

    // Hold each insert open for up to 3ms after it has read the run, so an
    // insert is in flight across the finish and the deletion in most
    // iterations rather than in a few.
    await pool.query(`
      CREATE OR REPLACE FUNCTION workflow.test_jitter_chunk_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(random() * 0.003); RETURN NEW; END $$`);
    await pool.query(`
      CREATE OR REPLACE TRIGGER test_jitter_chunk_insert
      BEFORE INSERT ON workflow.workflow_stream_chunks
      FOR EACH ROW EXECUTE FUNCTION workflow.test_jitter_chunk_insert()`);
  }, 120_000);

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  async function startRun(zeroRetention: boolean): Promise<string> {
    const created = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'deployment-1',
        workflowName: 'stream-deletion-race',
        input: new Uint8Array([1]),
        ...(zeroRetention
          ? {
              attributes: { [RETENTION_ATTRIBUTE]: '0' },
              allowReservedAttributes: true,
            }
          : {}),
      },
    });
    const runId = created.run?.runId;
    if (!runId) throw new Error('Expected run to be created');
    await events.create(runId, { eventType: 'run_started' });
    return runId;
  }

  async function chunksWithBytes(runId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM workflow.workflow_stream_chunks
        WHERE run_id = $1 AND octet_length(data) > 0`,
      [runId]
    );
    return rows[0].n;
  }

  for (const mode of ['deleteDataMany', '$retention: 0'] as const) {
    it(`leaves no chunk bytes readable once ${mode} has deleted the data`, async () => {
      const seen = { inTable: 0, throughWorld: 0, atRest: 0 };
      let writesBeforeDeletion = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const runId = await startRun(mode === '$retention: 0');
        let stop = false;
        let deleted = false;
        const writer = async (index: number) => {
          for (let n = 0; !stop; n++) {
            if (n % 3 === 2) {
              await streamer.streams.writeMulti(runId, `stream-${index}`, [
                'secret-a',
                'secret-b',
              ]);
            } else {
              await streamer.streams.write(runId, `stream-${index}`, 'secret');
            }
            if (!deleted) writesBeforeDeletion++;
          }
        };
        const writers = Array.from({ length: WRITERS }, (_, w) => writer(w));
        try {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 25)
          );
          // For a zero-retention run the terminal write deletes the data
          // before it returns.
          await events.create(runId, {
            eventType: 'run_completed',
            eventData: { output: new Uint8Array([9]) },
          });
          if (mode === 'deleteDataMany') {
            const result = await runs.deleteDataMany?.({ runIds: [runId] });
            expect(result?.results).toEqual([{ runId, outcome: 'deleted' }]);
          }
          deleted = true;

          const until = Date.now() + WATCH_MS;
          while (Date.now() < until) {
            if ((await chunksWithBytes(runId)) > 0) seen.inTable++;
            const page = await streamer.streams.getChunks(runId, 'stream-0');
            if (page.data.some((chunk) => chunk.data.byteLength > 0)) {
              seen.throughWorld++;
            }
          }
        } finally {
          stop = true;
          await Promise.all(writers);
        }
        seen.atRest += await chunksWithBytes(runId);
      }

      // The race was run: writers were writing before the deletions.
      expect(writesBeforeDeletion).toBeGreaterThan(ITERATIONS);
      expect(seen).toEqual({ inTable: 0, throughWorld: 0, atRest: 0 });
    }, 300_000);
  }
});
