import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createStreamer } from '../src/streamer.js';

/**
 * A producer that retries a terminal write (lost ACK, overlapping attempts)
 * appends data/EOF rows after the stream's first EOF via the ordinary
 * `write`/`close` API, which has no guard against writing to an
 * already-closed stream. `streams.get()` ignores those rows; `getChunks()`
 * and `getInfo()` read the same table and must ignore them too.
 */
describe('Postgres stream reads after a retried terminal write', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

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

    pool = new Pool({ connectionString: dbUrl, max: 4 });
    const drizzle = createClient(pool);
    streamer = createStreamer(pool, drizzle);
  }, 120_000);

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  async function writeStreamWithRetriedClose(runId: string, name: string) {
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      await streamer.streams.write(runId, name, text);
    }
    await streamer.streams.close(runId, name);
    // The retried terminal write: a lost ACK or overlapping attempt appends
    // another data row and EOF after the first EOF.
    await streamer.streams.write(runId, name, 'e');
    await streamer.streams.close(runId, name);
  }

  test('getChunks() excludes rows written after the first EOF', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await writeStreamWithRetriedClose(runId, name);

    const result = await streamer.streams.getChunks(runId, name);

    expect(result.data.map((c) => Buffer.from(c.data).toString())).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.done).toBe(true);
  });

  test('getChunks() paginates only up to the first EOF, not past it', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await writeStreamWithRetriedClose(runId, name);

    const page = await streamer.streams.getChunks(runId, name, { limit: 3 });
    expect(page.data.map((c) => Buffer.from(c.data).toString())).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).not.toBeNull();

    const rest = await streamer.streams.getChunks(runId, name, {
      cursor: page.cursor ?? undefined,
    });
    expect(rest.data.map((c) => Buffer.from(c.data).toString())).toEqual([
      'd',
      'e',
    ]);
    expect(rest.hasMore).toBe(false);
  });

  test('getInfo() does not count rows written after the first EOF', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await writeStreamWithRetriedClose(runId, name);

    const info = await streamer.streams.getInfo(runId, name);

    expect(info.tailIndex).toBe(4);
    expect(info.done).toBe(true);
  });
});
