import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
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
import { createStreamer, type PostgresStreamer } from '../src/streamer.js';

const RUN_ID = 'wrun_streamer_test';

/** Drain a stream to completion, decoding every chunk as UTF-8. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(Buffer.from(value).toString('utf-8'));
  }
  return out;
}

/** Distinct, variable-length payload for chunk `i`. */
function chunkBody(i: number): string {
  return `chunk-${String(i).padStart(3, '0')}-${'x'.repeat(i % 5)}`;
}

describe('Streamer (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let streamer: PostgresStreamer;

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;

    // Apply schema
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    pool = new Pool({ connectionString: dbUrl, max: 5 });
    streamer = createStreamer(pool, createClient(pool));

    // createStreamer sets up its LISTEN subscription asynchronously; wait
    // for it so tests can rely on live NOTIFY delivery.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'LISTEN %' LIMIT 1"
      );
      if (res.rowCount) break;
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the streamer LISTEN client');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 120_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE workflow.workflow_stream_chunks');
  });

  afterAll(async () => {
    if (streamer) {
      await streamer.close();
    }
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  describe('streams.get pagination', () => {
    /** Write `count` chunks (and an EOF marker) to a fresh stream. */
    async function seedClosedStream(
      name: string,
      count: number
    ): Promise<string[]> {
      const bodies = Array.from({ length: count }, (_, i) => chunkBody(i));
      await streamer.streams.writeMulti(RUN_ID, name, bodies);
      await streamer.streams.close(RUN_ID, name);
      return bodies;
    }

    it('reads a closed stream across multiple page boundaries byte-exact', async () => {
      // 200 chunks + EOF marker spans four keyset pages of 64
      const expected = await seedClosedStream('stream-full', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-full')
      );

      expect(chunks).toEqual(expected);
    });

    it('returns an empty stream when only the EOF marker exists', async () => {
      await streamer.streams.close(RUN_ID, 'stream-empty');

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-empty')
      );

      expect(chunks).toEqual([]);
    });

    it('starts at an exact page boundary', async () => {
      const expected = await seedClosedStream('stream-page-edge', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-page-edge', 64)
      );

      expect(chunks).toEqual(expected.slice(64));
    });

    it('starts mid-page', async () => {
      const expected = await seedClosedStream('stream-mid-page', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-mid-page', 100)
      );

      expect(chunks).toEqual(expected.slice(100));
    });

    it('starts at the last chunk', async () => {
      const expected = await seedClosedStream('stream-tail', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-tail', 199)
      );

      expect(chunks).toEqual([expected[199]]);
    });

    it('starts past the tail of a closed stream', async () => {
      await seedClosedStream('stream-past-tail', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-past-tail', 200)
      );

      expect(chunks).toEqual([]);
    });

    it('resolves a negative start index from the end of the stream', async () => {
      const expected = await seedClosedStream('stream-negative', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-negative', -5)
      );

      expect(chunks).toEqual(expected.slice(195));
    });

    it('clamps a negative start index larger than the stream to zero', async () => {
      const expected = await seedClosedStream('stream-negative-clamp', 200);

      const chunks = await readAll(
        await streamer.streams.get(RUN_ID, 'stream-negative-clamp', -1000)
      );

      expect(chunks).toEqual(expected);
    });

    it('hands off from history to live delivery without gaps or duplicates', async () => {
      const name = 'stream-handoff';
      const expected = Array.from({ length: 150 }, (_, i) => chunkBody(i));

      // Seed enough history to cross a page boundary, then start reading
      // while the tail is still being written.
      await streamer.streams.writeMulti(RUN_ID, name, expected.slice(0, 100));

      const reader = (await streamer.streams.get(RUN_ID, name)).getReader();
      const received: string[] = [];

      const first = await reader.read();
      if (first.done) throw new Error('Expected a first chunk');
      received.push(Buffer.from(first.value).toString('utf-8'));

      for (const body of expected.slice(100)) {
        await streamer.streams.write(RUN_ID, name, body);
      }
      await streamer.streams.close(RUN_ID, name);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(Buffer.from(value).toString('utf-8'));
      }

      expect(received).toEqual(expected);
    });

    it('applies a start index beyond the current tail to later live chunks', async () => {
      const name = 'stream-offset-spill';
      const bodies = Array.from({ length: 20 }, (_, i) => chunkBody(i));

      // Only 10 chunks exist when the reader starts at index 15: the first
      // page skips what it can in SQL and the remaining offset must skip
      // chunks 10-14 as they arrive.
      await streamer.streams.writeMulti(RUN_ID, name, bodies.slice(0, 10));

      // Quiesce before and after subscribing: a NOTIFY event observed for a
      // row the historical read also skips in SQL decrements the offset
      // twice, since offset-skipped rows never advance the dedup cursor (a
      // pre-existing property of get()'s offset handling, unchanged here),
      // which would shift delivery one chunk early.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const stream = await streamer.streams.get(RUN_ID, name, 15);

      await new Promise((resolve) => setTimeout(resolve, 250));

      for (const body of bodies.slice(10)) {
        await streamer.streams.write(RUN_ID, name, body);
      }
      await streamer.streams.close(RUN_ID, name);

      expect(await readAll(stream)).toEqual(bodies.slice(15));
    });

    it('stops cleanly when the reader cancels mid-history', async () => {
      await seedClosedStream('stream-cancel', 200);

      const reader = (
        await streamer.streams.get(RUN_ID, 'stream-cancel')
      ).getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel();

      // Give any in-flight page a chance to settle; a cancelled stream
      // must not enqueue (which would surface as an unhandled rejection).
      await new Promise((resolve) => setTimeout(resolve, 100));
      await streamer.streams.write(RUN_ID, 'stream-cancel', 'late-write');
    });
  });
});
