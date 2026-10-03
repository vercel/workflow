import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { STREAM_READ_PAGE_SIZE } from '../src/paged-stream.js';
import { createStreamer } from '../src/streamer.js';

/**
 * `streams.get()` reads history in keyset pages pulled by the consumer, and
 * NOTIFY only wakes a reader that caught up. These cases run the real
 * streamer on Postgres: byte-exact reads across pages, every start-index
 * shape, the rows a retried terminal write appends after the first EOF, the
 * history-to-live handoff, listener cleanup, and the page bound itself.
 */
describe('Postgres paged streams.get()', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let streamer: ReturnType<typeof createStreamer>;
  // Rows returned by each stream-chunk SELECT the streamer runs.
  const chunkSelectRows: number[] = [];

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
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    (pool as unknown as { query: unknown }).query = async (
      ...args: unknown[]
    ) => {
      const result = (await query(...args)) as { rows?: unknown[] };
      const text =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] as { text?: string } | undefined)?.text;
      if (
        text?.startsWith('select') &&
        text.includes('stream_chunks') &&
        text.includes('"data"') &&
        Array.isArray(result.rows)
      ) {
        chunkSelectRows.push(result.rows.length);
      }
      return result;
    };
    streamer = createStreamer(pool, createClient(pool));
  }, 120_000);

  afterAll(async () => {
    await streamer.close();
    await pool.end();
    await container.stop();
  });

  async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
    const reader = stream.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      chunks.push(Buffer.from(value).toString());
    }
  }

  async function writeClosedStream(count: number) {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await streamer.streams.writeMulti(
      runId,
      name,
      Array.from({ length: count }, (_value, index) => `${index}`)
    );
    await streamer.streams.close(runId, name);
    return { runId, name };
  }

  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from) }, (_v, i) => `${from + i}`);

  test('reads a long stream byte for byte with bounded queries', async () => {
    const count = STREAM_READ_PAGE_SIZE * 3 + 8;
    const { runId, name } = await writeClosedStream(count);
    chunkSelectRows.length = 0;
    await expect(
      drain(await streamer.streams.get(runId, name))
    ).resolves.toEqual(range(0, count));
    expect(chunkSelectRows.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...chunkSelectRows)).toBeLessThanOrEqual(
      STREAM_READ_PAGE_SIZE
    );
  });

  test.each([
    ['a page edge', 64, 64],
    ['mid-page', 100, 100],
    ['the last row', 199, 199],
    ['the data count', 200, 200],
    ['one past the data count', 201, 200],
    ['far past the data count', 10_000, 200],
    ['-1', -1, 199],
    ['-64', -64, 136],
    ['a clamped negative index', -1_000, 0],
  ])('start index at %s', async (_label, startIndex, firstDelivered) => {
    const { runId, name } = await writeClosedStream(200);
    await expect(
      drain(await streamer.streams.get(runId, name, startIndex))
    ).resolves.toEqual(range(firstDelivered, 200));
  });

  async function writeStreamWithRetriedClose() {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      await streamer.streams.write(runId, name, text);
    }
    await streamer.streams.close(runId, name);
    // A retried terminal write appends a data row and an EOF after the first EOF.
    await streamer.streams.write(runId, name, 'e');
    await streamer.streams.close(runId, name);
    return { runId, name };
  }

  test.each([
    [0, ['a', 'b', 'c', 'd', 'e']],
    [3, ['d', 'e']],
    [5, []],
    [6, []],
    [-1, ['e']],
    [-2, ['d', 'e']],
  ])('ignores rows written after the first EOF (start index %i)', async (startIndex, expected) => {
    const { runId, name } = await writeStreamWithRetriedClose();
    await expect(
      drain(await streamer.streams.get(runId, name, startIndex))
    ).resolves.toEqual(expected);
  });

  test('hands off from history to live rows without gaps or duplicates', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await streamer.streams.writeMulti(runId, name, range(0, 100));
    const reader = (await streamer.streams.get(runId, name)).getReader();
    const received: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { done, value } = await reader.read();
      if (done) throw new Error('the stream closed early');
      received.push(Buffer.from(value).toString());
    }
    const writing = (async () => {
      for (const text of range(100, 150)) {
        await streamer.streams.write(runId, name, text);
      }
      await streamer.streams.close(runId, name);
    })();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(Buffer.from(value).toString());
    }
    await writing;
    expect(received).toEqual(range(0, 150));
  });

  test('applies a start index past the current tail to rows written later', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await streamer.streams.writeMulti(runId, name, ['0', '1', '2']);
    const stream = await streamer.streams.get(runId, name, 5);
    await streamer.streams.writeMulti(runId, name, ['3', '4', '5', '6']);
    await streamer.streams.close(runId, name);
    await expect(drain(stream)).resolves.toEqual(['5', '6']);
  });

  describe('listeners', () => {
    let emitters: Set<EventEmitter>;
    const listenerCount = (name: string) =>
      [...emitters].reduce(
        (sum, emitter) => sum + emitter.listenerCount(`strm:${name}`),
        0
      );

    beforeEach(() => {
      emitters = new Set();
      const on = EventEmitter.prototype.on;
      vi.spyOn(EventEmitter.prototype, 'on').mockImplementation(function (
        this: EventEmitter,
        eventName,
        listener
      ) {
        if (typeof eventName === 'string' && eventName.startsWith('strm:')) {
          emitters.add(this);
        }
        return on.call(this, eventName, listener);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('repeated reads of a closed stream leave no listener behind', async () => {
      const { runId, name } = await writeClosedStream(3);
      const warnings: Error[] = [];
      const onWarning = (warning: Error) => warnings.push(warning);
      process.on('warning', onWarning);
      try {
        for (let i = 0; i < 12; i++) {
          await drain(await streamer.streams.get(runId, name));
          expect(listenerCount(name)).toBe(0);
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(
          warnings.filter((w) => w.name === 'MaxListenersExceededWarning')
        ).toEqual([]);
      } finally {
        process.removeListener('warning', onWarning);
      }
    });

    test('a cancelled reader detaches its listener', async () => {
      const runId = `run_${randomUUID()}`;
      const name = `stream_${randomUUID()}`;
      await streamer.streams.write(runId, name, 'a');
      const reader = (await streamer.streams.get(runId, name)).getReader();
      await reader.read();
      expect(listenerCount(name)).toBe(1);
      await reader.cancel();
      expect(listenerCount(name)).toBe(0);
    });
  });

  test('closing the streamer fails pending readers', async () => {
    const own = createStreamer(pool, createClient(pool));
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    await own.streams.write(runId, name, 'a');
    const reader = (await own.streams.get(runId, name)).getReader();
    await reader.read();
    const pending = expect(reader.read()).rejects.toThrow(
      'streamer has been closed'
    );
    await own.close();
    await pending;
    await expect(own.streams.get(runId, name)).rejects.toThrow(
      'streamer has been closed'
    );
  });
});
