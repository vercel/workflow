import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createStreamer } from '../src/streamer.js';
import { TestPool } from './pool.js';

describe('Postgres stream batch notifications', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const applicationName = `stream_batch_${randomUUID().replaceAll('-', '')}`;

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
    streamer = createStreamer(pool, createClient(pool));
  }, 120_000);

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  test('a batch costs one NOTIFY and one range SELECT per listening process', async () => {
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

    const statements: string[] = [];
    const query = pool.query.bind(pool);
    vi.spyOn(pool, 'query').mockImplementation(((
      config: string | { text: string },
      ...rest: unknown[]
    ) => {
      statements.push(typeof config === 'string' ? config : config.text);
      return (query as (...args: unknown[]) => unknown)(config, ...rest);
    }) as typeof pool.query);
    const notifies = () =>
      statements.filter((text) => text.includes('pg_notify')).length;
    const chunkReads = () =>
      statements.filter(
        (text) =>
          text.startsWith('select') && text.includes('workflow_stream_chunks')
      ).length;

    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    const stream = await streamer.streams.get(runId, name);
    await expect.poll(chunkReads).toBe(1);
    statements.length = 0;

    const chunks = Array.from({ length: 50 }, (_, i) => `chunk ${i};`);
    await streamer.streams.writeMulti(runId, name, chunks);
    await streamer.streams.close(runId, name);

    const received = await new Response(stream).text();
    expect(received).toBe(chunks.join(''));
    expect(notifies()).toBe(2);
    expect(chunkReads()).toBe(2);
  });
});
