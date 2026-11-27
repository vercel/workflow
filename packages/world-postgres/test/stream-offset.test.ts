import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createStreamer } from '../src/streamer.js';
import { TestPool } from './pool.js';

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
  let pool: TestPool;
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

    pool = new TestPool({
      connectionString: dbUrl,
      application_name: applicationName,
      max: 4,
    });
    const drizzle = createClient(pool);
    streamer = createStreamer(pool, drizzle);

    // The streamer subscribes in the background; a NOTIFY sent before its
    // LISTEN is registered would be lost and the test would hang on read().
    await vi.waitFor(async () => {
      const result = await pool.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE application_name = $1
         AND query = 'LISTEN workflow_event_chunk' AND state = 'idle'`,
        [applicationName]
      );
      expect(result.rows[0].count).toBe(1);
    }, 30_000);
  }, 120_000);

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  test('a repeated notification for a skipped chunk does not consume the offset twice', async () => {
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

  async function readAll(stream: ReadableStream<Uint8Array>) {
    let out = '';
    for await (const chunk of stream) out += Buffer.from(chunk).toString();
    return out;
  }

  async function payloadBytesWhile<T>(fn: () => Promise<T>) {
    let bytes = 0;
    const query = pool.query.bind(pool) as (
      ...args: unknown[]
    ) => Promise<{ rows: object[] }>;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (
      ...args: unknown[]
    ) => {
      const res = await query(...args);
      for (const value of res.rows.flatMap(Object.values)) {
        if (Buffer.isBuffer(value)) bytes += value.byteLength;
      }
      return res;
    }) as never);
    try {
      return { value: await fn(), bytes };
    } finally {
      spy.mockRestore();
    }
  }

  const chunks = ['x'.repeat(100_000), 'y'.repeat(100_000), 'suffix'];

  test.each([
    [undefined, 0, 200_006],
    [1, 1, 100_006],
    [2, 2, 6],
    [3, 3, 0],
    [4, 3, 0],
    [Number.POSITIVE_INFINITY, 3, 0],
    [-1, 2, 200_006],
  ])('startIndex %s delivers from chunk %i and reads %i payload bytes', async (startIndex, from, expectedBytes) => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await streamer.streams.writeMulti(runId, name, chunks);
    await streamer.streams.close(runId, name);

    const { value, bytes } = await payloadBytesWhile(async () =>
      readAll(await streamer.streams.get(runId, name, startIndex))
    );
    expect(value).toBe(chunks.slice(from).join(''));
    expect(bytes).toBe(expectedBytes);
  });

  test('a start index past the tail of an open stream waits for the next chunk', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await streamer.streams.writeMulti(runId, name, ['a', 'b']);
    const reader = (await streamer.streams.get(runId, name, 3)).getReader();
    try {
      await streamer.streams.write(runId, name, 'c');
      await streamer.streams.write(runId, name, 'd');
      const result = await reader.read();
      expect(Buffer.from(result.value as Uint8Array).toString()).toBe('d');
    } finally {
      await reader.cancel();
    }
  });
});
