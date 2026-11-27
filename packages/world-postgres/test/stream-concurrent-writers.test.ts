import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createStreamer } from '../src/streamer.js';
import { TestPool } from './pool.js';

const decode = (chunk: Uint8Array) => Buffer.from(chunk).toString();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(decode(chunk));
  return out;
}

/**
 * Several writers can append to one stream at the same time: steps of one run
 * in one process, or in processes that share the database. A live reader must
 * deliver every chunk exactly once, in the order `getStreamChunks()` and an
 * indexed `readFromStream()` read them back, or a reader that reconnects by index skips some
 * chunks and repeats others.
 */
describe('Postgres stream with concurrent writers', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  const pools: TestPool[] = [];
  const streamers: ReturnType<typeof createStreamer>[] = [];

  // One streamer per simulated process: each has its own pool, LISTEN client
  // and chunk-id generator.
  const newStreamer = (dbUrl: string) => {
    const pool = new TestPool({ connectionString: dbUrl, max: 4 });
    const streamer = createStreamer(pool, createClient(pool));
    pools.push(pool);
    streamers.push(streamer);
    return streamer;
  };

  let reader: ReturnType<typeof createStreamer>;
  let writerA: ReturnType<typeof createStreamer>;
  let writerB: ReturnType<typeof createStreamer>;

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
    reader = newStreamer(dbUrl);
    writerA = newStreamer(dbUrl);
    writerB = newStreamer(dbUrl);
  }, 120_000);

  afterAll(async () => {
    for (const streamer of streamers) await streamer.close();
    for (const pool of pools) await pool.end();
    await container.stop();
  });

  async function storedChunks(runId: string, name: string) {
    const stored: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await reader.getStreamChunks(name, runId, {
        cursor,
        limit: 100,
      });
      stored.push(...page.data.map((c) => decode(c.data)));
      if (!page.hasMore) return stored;
      cursor = page.cursor ?? undefined;
    }
  }

  async function waitForListener() {
    // `listenChannel` subscribes asynchronously; give it a moment so the
    // reader is live before the writes start.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  test('a live reader sees every chunk of two writers in stored order', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    const perWriter = 150;

    await waitForListener();
    const live = readAll(await reader.readFromStream(name));
    await waitForListener();

    const write = async (
      streamer: ReturnType<typeof createStreamer>,
      tag: string
    ) => {
      for (let i = 0; i < perWriter; i++) {
        await streamer.writeToStream(name, runId, `${tag}${i}`);
      }
    };
    await Promise.all([write(writerA, 'a'), write(writerB, 'b')]);
    await writerA.closeStream(name, runId);

    const delivered = await live;
    const stored = await storedChunks(runId, name);

    expect(stored).toHaveLength(2 * perWriter);
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered).toEqual(stored);
    // Each writer's own chunks keep the order it wrote them in.
    for (const tag of ['a', 'b']) {
      expect(delivered.filter((c) => c.startsWith(tag))).toEqual(
        Array.from({ length: perWriter }, (_, i) => `${tag}${i}`)
      );
    }
  });

  test('a write whose runId resolves late does not hide later writes from a live reader', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;

    await waitForListener();
    const live = readAll(await reader.readFromStream(name));
    await waitForListener();

    // `writeToStreamMulti` takes its chunk ids before it awaits the runId, so a
    // pending runId gives it ids below those of writes that land first.
    let resolveRunId!: (id: string) => void;
    const lateRunId = new Promise<string>((r) => {
      resolveRunId = r;
    });
    const slow = writerA.writeToStreamMulti(name, lateRunId, ['s0', 's1']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writerB.writeToStream(name, runId, 'fast');
    await new Promise((resolve) => setTimeout(resolve, 100));
    resolveRunId(runId);
    await slow;
    await writerB.closeStream(name, runId);

    const delivered = await live;
    const stored = await storedChunks(runId, name);
    expect([...delivered].sort()).toEqual(['fast', 's0', 's1']);
    expect(delivered).toEqual(stored);
  });

  test('a write lands after a chunk from a writer whose clock runs ahead', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;

    await waitForListener();
    const live = readAll(await reader.readFromStream(name));
    await waitForListener();

    // Another process whose clock is a minute ahead wrote a chunk: its id is
    // above any id this process generates for the next minute.
    const aheadId = `chnk_${ulid(Date.now() + 60_000)}`;
    await pools[0].query(
      `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, run_id, data, eof)
       VALUES ($1, $2, $3, $4, false)`,
      [aheadId, name, runId, Buffer.from('ahead')]
    );
    await pools[0].query('SELECT pg_notify($1, $2)', [
      'workflow_event_chunk',
      JSON.stringify({ streamId: name, chunkId: aheadId }),
    ]);
    await writerA.writeToStreamMulti(name, runId, ['behind0', 'behind1']);
    await writerA.writeToStream(name, runId, 'behind2');
    await writerA.closeStream(name, runId);

    const expected = ['ahead', 'behind0', 'behind1', 'behind2'];
    expect(await live).toEqual(expected);
    expect(await storedChunks(runId, name)).toEqual(expected);
  });

  test('a reader that resumes by index after a live read sees no gaps or repeats', async () => {
    const runId = `run_${randomUUID()}`;
    const name = `stream_${randomUUID()}`;
    const perWriter = 100;

    await waitForListener();
    const reader1 = (await reader.readFromStream(name)).getReader();
    await waitForListener();

    const write = async (
      streamer: ReturnType<typeof createStreamer>,
      tag: string
    ) => {
      for (let i = 0; i < perWriter; i++) {
        await streamer.writeToStream(name, runId, `${tag}${i}`);
      }
    };
    const writes = Promise.all([write(writerA, 'a'), write(writerB, 'b')]);

    // Read part of the stream live, then drop the reader and resume from the
    // number of chunks seen, as core's reconnecting reader does.
    const firstPart: string[] = [];
    while (firstPart.length < perWriter) {
      const { value, done } = await reader1.read();
      if (done) break;
      firstPart.push(decode(value));
    }
    await reader1.cancel();
    await writes;
    await writerA.closeStream(name, runId);

    const rest = await readAll(
      await reader.readFromStream(name, firstPart.length)
    );
    const all = [...firstPart, ...rest];
    expect(all).toHaveLength(2 * perWriter);
    expect(new Set(all).size).toBe(all.length);
  });
});
