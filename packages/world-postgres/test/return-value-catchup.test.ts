import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createStreamer, type PostgresStreamer } from '../src/streamer.js';

/**
 * Per-world verification for the return-value fast path against the *real*
 * world-postgres streamer (NOTIFY/LISTEN + durable rows). The core waiter is
 * world-agnostic and unit-tested elsewhere; what varies per world is the
 * streamer's catch-up contract, verified directly here:
 *
 *   write(runId, name, <1 byte marker>) → close(runId, name)
 *   then a reader opening get(runId, name, 0) observes the marker (or the
 *   close), whether it attaches after the terminal write (durable replay) or
 *   races it (live NOTIFY delivery).
 *
 * This is exactly the sequence `signalRunTerminal` emits and
 * `createReturnValueSignalWaiter` consumes.
 */

const MARKER = new Uint8Array([1]);
const SIGNAL_DEADLINE_MS = 5_000;

/**
 * Mirror the waiter: read from index 0 until the first non-empty chunk or the
 * close, skipping any leading empty (header) chunk. Resolves { sawMarker,
 * closed }. Rejects if neither happens within the deadline — proving the
 * catch-up contract, not a hang.
 */
async function observeSignal(
  streamer: PostgresStreamer,
  runId: string,
  name: string
): Promise<{ sawMarker: boolean; closed: boolean }> {
  const stream = await streamer.streams.get(runId, name, 0);
  const reader = stream.getReader();
  let sawMarker = false;
  let closed = false;
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`no signal within ${SIGNAL_DEADLINE_MS}ms`)),
      SIGNAL_DEADLINE_MS
    ).unref?.()
  );
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) {
        closed = true;
        break;
      }
      if (value && value.byteLength > 0) {
        sawMarker = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { sawMarker, closed };
}

// Skip on Windows since it relies on a docker container.
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  describe('return-value signal against world-postgres', () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: Pool;
    let streamer: PostgresStreamer;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      const dbUrl = container.getConnectionUri();
      process.env.WORKFLOW_POSTGRES_URL = dbUrl;
      process.env.DATABASE_URL = dbUrl;
      execSync('pnpm db:push', {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      });
      pool = new Pool({ connectionString: dbUrl });
      streamer = createStreamer(pool, createClient(pool));
    }, 120_000);

    afterAll(async () => {
      await streamer?.close().catch(() => {});
      await pool?.end().catch(() => {});
      if (container) await container.stop();
    });

    it('late attach: a reader opened after write+close catches up on the buffered marker/close', async () => {
      const runId = 'wrun_pgLate';
      const name = 'strm_pgLate_system_return';
      // Terminal signal fires and completes fully before any reader exists.
      await streamer.streams.write(runId, name, MARKER);
      await streamer.streams.close(runId, name);

      const { sawMarker, closed } = await observeSignal(streamer, runId, name);
      // Either observation is a valid wake for the waiter; the durable marker
      // should be replayed to the late reader.
      expect(sawMarker || closed).toBe(true);
      expect(sawMarker).toBe(true);
    });

    it('live fast path: a reader opened before the signal wakes when it fires', async () => {
      const runId = 'wrun_pgLive';
      const name = 'strm_pgLive_system_return';
      // Open the reader first, then emit the terminal signal.
      const observed = observeSignal(streamer, runId, name);
      // Give the reader a beat to attach its LISTEN/emitter before writing.
      await new Promise((r) => setTimeout(r, 50));
      await streamer.streams.write(runId, name, MARKER);
      await streamer.streams.close(runId, name);

      const { sawMarker, closed } = await observed;
      expect(sawMarker || closed).toBe(true);
    });
  });
}
