import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { monotonicFactory } from 'ulid';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';
import { createClient, type Drizzle } from '../src/drizzle/index.js';
import { createStreamer, listenChannel } from '../src/streamer.js';

async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`read() timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function killOtherBackends(connectionString: string): Promise<void> {
  // Terminate every backend in this database except the one running the
  // query — that includes the dedicated LISTEN client and any idle pool
  // connections. We use a throwaway pool so the issuing connection itself
  // doesn't survive in the shared pool (where a later acquire could pick it
  // up and emit a stale-socket error).
  const killer = new Pool({ connectionString, max: 1 });
  try {
    killer.on('error', () => {
      /* swallow tear-down errors */
    });
    await killer.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND datname = current_database()`
    );
  } finally {
    await killer.end().catch(() => {});
  }
}

describe('Streamer (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let connectionString: string;
  let pool: Pool;
  let drizzle: Drizzle;
  const ulid = monotonicFactory();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;
    process.env.WORKFLOW_POSTGRES_URL = connectionString;

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    pool = new Pool({ connectionString, max: 4 });
    // Stale-socket errors can surface on idle pool clients after we
    // pg_terminate_backend them. Pool re-acquires fresh connections
    // automatically; we just need to keep the error event from going unhandled.
    pool.on('error', () => {
      /* swallow */
    });
    drizzle = createClient(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE workflow.workflow_stream_chunks RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('polling fallback delivers chunks inserted without NOTIFY', async () => {
    // Polling-only path: short interval, no LISTEN involvement (we insert
    // rows via raw SQL so NOTIFY never fires for them). The reader must
    // still observe both the data chunk and EOF, proving the safety-net
    // SELECT in `streams.get` is wired up correctly.
    const streamer = createStreamer(pool, drizzle, { pollIntervalMs: 100 });
    try {
      const streamName = 'stream-poll-only';
      const stream = await streamer.streams.get('run-1', streamName);
      const reader = stream.getReader();

      // Give createStreamer's LISTEN subscription a moment to settle so the
      // initial DB read in start() has run. Polling tick fires every 100ms.
      await new Promise((r) => setTimeout(r, 50));

      // Insert directly — bypass streams.write so no pg_notify fires.
      const chunkId = `chnk_${ulid()}`;
      await pool.query(
        `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, run_id, data, eof)
         VALUES ($1, $2, $3, $4, false)`,
        [chunkId, streamName, 'run-1', Buffer.from([1, 2, 3])]
      );

      const first = await readNext(reader, 3_000);
      expect(first.done).toBe(false);
      expect(Array.from(first.value ?? [])).toEqual([1, 2, 3]);

      // Insert EOF marker — also via raw SQL, also relies on polling.
      const eofId = `chnk_${ulid()}`;
      await pool.query(
        `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, run_id, data, eof)
         VALUES ($1, $2, $3, $4, true)`,
        [eofId, streamName, 'run-1', Buffer.from([])]
      );

      const second = await readNext(reader, 3_000);
      expect(second.done).toBe(true);

      reader.releaseLock();
    } finally {
      await streamer.close();
    }
  }, 15_000);

  it('reader recovers after LISTEN backend is terminated', async () => {
    // End-to-end resilience: kill every backend (drops the dedicated LISTEN
    // client), then publish a chunk via streams.write. The NOTIFY for that
    // chunk reaches no live listener, so the only path to the reader is the
    // polling fallback. We assert the chunk still arrives.
    const streamer = createStreamer(pool, drizzle, { pollIntervalMs: 100 });
    try {
      const streamName = 'stream-reconnect';
      const stream = await streamer.streams.get('run-2', streamName);
      const reader = stream.getReader();

      // Wait for LISTEN to be established before terminating it.
      await new Promise((r) => setTimeout(r, 200));

      await killOtherBackends(connectionString);

      // Pool may briefly hand out the now-dead connection on the first call;
      // pg-Pool retries internally, but if our write itself races the kill we
      // retry once. This mirrors what application code would do.
      let writeOk = false;
      for (let attempt = 0; attempt < 3 && !writeOk; attempt++) {
        try {
          await streamer.streams.write(
            'run-2',
            streamName,
            new Uint8Array([7, 8, 9])
          );
          writeOk = true;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(writeOk).toBe(true);

      const first = await readNext(reader, 5_000);
      expect(first.done).toBe(false);
      expect(Array.from(first.value ?? [])).toEqual([7, 8, 9]);

      reader.releaseLock();
    } finally {
      await streamer.close();
    }
  }, 20_000);

  it('startIndex skip is idempotent across polling ticks', async () => {
    // Regression test: with polling enabled, `streams.get` re-queries
    // `chunk_id > lastChunkId` every tick. If `enqueue` skipped a chunk for
    // `startIndex` without advancing `lastChunkId`, the same chunk would
    // come back on the next poll and be skipped again — eventually
    // exhausting `offset` against the same physical chunks and delivering
    // them anyway.
    const streamer = createStreamer(pool, drizzle, { pollIntervalMs: 100 });
    try {
      const streamName = 'stream-startindex-poll';

      // Pre-populate two chunks. With startIndex=2 they must be skipped.
      const idA = `chnk_${ulid()}`;
      const idB = `chnk_${ulid()}`;
      await pool.query(
        `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, run_id, data, eof)
         VALUES ($1, $2, $3, $4, false), ($5, $2, $3, $6, false)`,
        [
          idA,
          streamName,
          'run-3',
          Buffer.from([0xaa]),
          idB,
          Buffer.from([0xbb]),
        ]
      );

      const stream = await streamer.streams.get('run-3', streamName, 2);
      const reader = stream.getReader();

      // Let several poll ticks run with only the two skip-chunks in DB. If
      // the bug regresses, polling will eventually deliver one of them.
      await new Promise((r) => setTimeout(r, 500));

      // Append a third chunk — this is the one the reader should receive.
      const idC = `chnk_${ulid()}`;
      await pool.query(
        `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, run_id, data, eof)
         VALUES ($1, $2, $3, $4, false)`,
        [idC, streamName, 'run-3', Buffer.from([0xcc])]
      );

      const next = await readNext(reader, 3_000);
      expect(next.done).toBe(false);
      expect(Array.from(next.value ?? [])).toEqual([0xcc]);

      reader.releaseLock();
    } finally {
      await streamer.close();
    }
  }, 15_000);

  it('clears polling timer on natural EOF (no resource leak)', async () => {
    // The polling fallback registers a `setInterval`. Without explicit
    // teardown on EOF, the timer keeps ticking forever once the consumer
    // has finished reading — a slow drift that holds the event loop alive
    // and accumulates per long-running stream. This test pins down the
    // contract: after `done: true`, every `setInterval` we created must
    // have been cleared.
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const POLL_MS = 73;

    const streamer = createStreamer(pool, drizzle, { pollIntervalMs: POLL_MS });
    try {
      const streamName = 'stream-eof-cleanup';
      const stream = await streamer.streams.get('run-eof', streamName);
      const reader = stream.getReader();

      await streamer.streams.write(
        'run-eof',
        streamName,
        new Uint8Array([1, 2])
      );
      await streamer.streams.close('run-eof', streamName);

      const first = await readNext(reader, 3_000);
      expect(first.done).toBe(false);

      const final = await readNext(reader, 3_000);
      expect(final.done).toBe(true);

      // Find every interval the streamer scheduled at our test poll cadence
      // (filter by delay so any unrelated intervals from other libs don't
      // pollute the assertion). Each one must appear in clearInterval
      // calls. We do NOT call reader.cancel() — the point of this test is
      // that EOF alone is enough to release resources.
      const ourIntervalIds = setSpy.mock.results
        .filter((_, i) => setSpy.mock.calls[i][1] === POLL_MS)
        .map((r) => r.value);
      expect(ourIntervalIds.length).toBeGreaterThan(0);

      const clearedIds = new Set(clearSpy.mock.calls.map((c) => c[0]));
      for (const id of ourIntervalIds) {
        expect(clearedIds.has(id)).toBe(true);
      }

      reader.releaseLock();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      await streamer.close();
    }
  }, 10_000);

  it('listenChannel reconnects after its backend is terminated', async () => {
    // Low-level test for listenChannel itself: terminate its dedicated
    // backend, wait past the initial 250ms backoff, then fire a NOTIFY.
    // A successful reconnect means the payload reaches our handler.
    const received: string[] = [];
    const sub = await listenChannel(
      pool,
      'workflow_test_reconnect',
      async (payload) => {
        received.push(payload);
      }
    );

    try {
      await new Promise((r) => setTimeout(r, 100));

      await killOtherBackends(connectionString);

      // Backoff is 250ms → 30s. First reconnect attempt fires at ~250ms.
      // Wait long enough for at least one reconnect cycle to succeed.
      await new Promise((r) => setTimeout(r, 1_500));

      // Notify retried in case the issuing pool connection itself is racing
      // a reconnect.
      let notified = false;
      for (let attempt = 0; attempt < 3 && !notified; attempt++) {
        try {
          await pool.query(`SELECT pg_notify('workflow_test_reconnect', $1)`, [
            'hello-after-reconnect',
          ]);
          notified = true;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(notified).toBe(true);

      // Allow propagation through the reconnected client.
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(received).toContain('hello-after-reconnect');
    } finally {
      await sub.close();
    }
  }, 20_000);
});
