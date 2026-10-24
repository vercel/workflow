import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import {
  createStreamer,
  LISTEN_RECONNECT_DELAY_MS,
  listenChannel,
} from '../src/streamer.js';

const STREAM_TOPIC = 'workflow_event_chunk';
const decode = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The dedicated LISTEN connection is ended by the server (database restart,
 * failover, `pg_terminate_backend`). The process must survive, the
 * subscription must come back, and stream readers must still receive chunks
 * whose notification was sent while no connection was listening.
 */
describe('Postgres LISTEN connection drop', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;

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
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  const listenBackends = async (channel: string) => {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE query = $1`,
      [`LISTEN ${channel}`]
    );
    return rows.map((row) => row.pid);
  };

  const terminateListeners = async (channel: string) => {
    const pids = await listenBackends(channel);
    expect(pids).toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [pids[0]]);
  };

  test('re-subscribes and keeps delivering notifications', async () => {
    const channel = `listen_reconnect_${randomUUID().replaceAll('-', '')}`;
    const payloads: string[] = [];
    const onReconnect = vi.fn();
    const sub = await listenChannel(
      pool,
      channel,
      async (payload) => {
        payloads.push(payload);
      },
      { onReconnect }
    );
    try {
      await terminateListeners(channel);
      await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1), {
        timeout: LISTEN_RECONNECT_DELAY_MS * 10,
      });
      expect(await listenBackends(channel)).toHaveLength(1);

      await pool.query('SELECT pg_notify($1, $2)', [channel, 'after']);
      await vi.waitFor(() => expect(payloads).toEqual(['after']));
    } finally {
      await sub.close();
    }
    expect(await listenBackends(channel)).toHaveLength(0);
  });

  test('close() during an outage stops reconnecting', async () => {
    const channel = `listen_reconnect_${randomUUID().replaceAll('-', '')}`;
    const onReconnect = vi.fn();
    const sub = await listenChannel(pool, channel, async () => {}, {
      onReconnect,
    });
    await terminateListeners(channel);
    await sub.close();

    await new Promise((resolve) =>
      setTimeout(resolve, LISTEN_RECONNECT_DELAY_MS * 3)
    );
    expect(onReconnect).not.toHaveBeenCalled();
    expect(await listenBackends(channel)).toHaveLength(0);
  });

  test('a reader receives chunks and EOF written while LISTEN was down', async () => {
    const streamer = createStreamer(pool, createClient(pool));
    try {
      const runId = `wrun_${randomUUID()}`;
      const name = `strm_${randomUUID()}`;
      const reader = (await streamer.streams.get(runId, name)).getReader();
      // The streamer subscribes asynchronously at construction.
      await vi.waitFor(async () =>
        expect(await listenBackends(STREAM_TOPIC)).toHaveLength(1)
      );

      await streamer.streams.write(runId, name, 'a');
      const first = await reader.read();
      expect(decode(first.value)).toBe('a');

      await terminateListeners(STREAM_TOPIC);
      // Written before the replacement connection listens: these
      // notifications are lost and only the post-reconnect re-read
      // delivers them.
      await streamer.streams.write(runId, name, 'b');
      await streamer.streams.close(runId, name);

      const rest: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest.push(decode(value));
      }
      expect(rest).toEqual(['b']);

      // Live notifications flow on the replacement connection.
      const live = `strm_${randomUUID()}`;
      const liveReader = (await streamer.streams.get(runId, live)).getReader();
      await streamer.streams.write(runId, live, 'c');
      const next = await liveReader.read();
      expect(decode(next.value)).toBe('c');
      await liveReader.cancel();
    } finally {
      await streamer.close();
    }
  }, 30_000);
});
