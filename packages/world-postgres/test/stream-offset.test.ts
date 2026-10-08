import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createStreamer } from '../src/streamer.js';

/**
 * `streams.get(runId, name, startIndex)` skips `startIndex` chunks before it
 * starts delivering. The reader learns about chunks twice when a write lands
 * while the initial SELECT is in flight: once from that SELECT and once from
 * the buffered NOTIFY. The dedup cursor has to advance for a skipped chunk as
 * well, or the repeat counts against the offset a second time and the reader
 * receives data from before the requested position.
 */
describe('Postgres stream offsets', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  // Identifies this test's connections (including the streamer's dedicated
  // LISTEN client, which inherits the pool options) in pg_stat_activity.
  const applicationName = `stream_offset_${randomUUID().replaceAll('-', '')}`;

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
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

    pool = new Pool({
      connectionString: dbUrl,
      application_name: applicationName,
      max: 4,
    });
    const drizzle = createClient(pool);
    streamer = createStreamer(pool, drizzle);
  }, 120_000);

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  test('a repeated notification for a skipped chunk does not consume the offset twice', async () => {
    // The streamer subscribes in the background; a NOTIFY sent before its
    // LISTEN is registered would be lost and the test would hang on read().
    await expect
      .poll(async () => {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE application_name = $1
           AND query = 'LISTEN workflow_event_chunk' AND state = 'idle'`,
          [applicationName]
        );
        return result.rows[0].count;
      })
      .toBe(1);

    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    const stream = await streamer.streams.get(runId, name, 2);
    const reader = stream.getReader();
    try {
      await streamer.streams.write(runId, name, 'first');
      const first = await pool.query(
        'SELECT id FROM workflow.workflow_stream_chunks WHERE stream_id = $1',
        [name]
      );
      // Replay the notification the write already sent for the first chunk.
      await pool.query('SELECT pg_notify($1, $2)', [
        'workflow_event_chunk',
        JSON.stringify({ streamId: name, chunkId: first.rows[0].id }),
      ]);
      await streamer.streams.write(runId, name, 'second');
      await streamer.streams.write(runId, name, 'third');
      const result = await reader.read();
      expect(result.done).toBe(false);
      expect(Buffer.from(result.value as Uint8Array).toString()).toBe('third');
    } finally {
      await reader.cancel();
    }
  });
});
