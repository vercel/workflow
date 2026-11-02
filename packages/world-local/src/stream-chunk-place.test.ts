import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { chunkSuccessor, newestChunkId } from './stream-chunk-place.js';
import { createStreamer, deserializeChunk } from './streamer.js';

const TEST_RUN_ID = 'wrun_test12345678901234';
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-place-test-'));
  onTestFinished(async (ctx) => {
    if (!ctx.task.result?.errors?.length) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  return dir;
}

/** Every chunk of a stream, as text, in the order a read from 0 gives. */
async function replayOf(
  streamer: ReturnType<typeof createStreamer>,
  name: string
) {
  const page = await streamer.streams.getChunks(TEST_RUN_ID, name, {
    limit: 1000,
  });
  return page.data.map((chunk) => decoder.decode(chunk.data));
}

/** A reader that follows a stream from its start, as one in another process. */
async function follow(
  streamer: ReturnType<typeof createStreamer>,
  name: string
) {
  const reader = (await streamer.streams.get(TEST_RUN_ID, name, 0)).getReader();
  const chunks: string[] = [];
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      chunks.push(decoder.decode(value));
    }
  })();
  return {
    chunks,
    async until(count: number) {
      for (let waited = 0; chunks.length < count && waited < 5000; ) {
        await sleep(20);
        waited += 20;
      }
    },
    async stop() {
      await reader.cancel();
      await reading;
    },
  };
}

const realLink = fs.link.bind(fs);
const realRename = fs.rename.bind(fs);
const textOf = async (file: unknown) =>
  decoder.decode(deserializeChunk(await fs.readFile(String(file))).chunk);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chunkSuccessor', () => {
  it('counts up in the ULID alphabet and carries', () => {
    expect(chunkSuccessor('0'.repeat(26))).toBe(`${'0'.repeat(25)}1`);
    expect(chunkSuccessor(`${'0'.repeat(25)}9`)).toBe(`${'0'.repeat(25)}A`);
    expect(chunkSuccessor(`${'0'.repeat(25)}H`)).toBe(`${'0'.repeat(25)}J`);
    expect(chunkSuccessor('01ARZ3NDEKTSV4RRFFQ69G5FAZ')).toBe(
      '01ARZ3NDEKTSV4RRFFQ69G5FB0'
    );
  });

  it('refuses what is not a chunk id, and the last one', () => {
    expect(() => chunkSuccessor('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toThrow();
    expect(() => chunkSuccessor('Z'.repeat(26))).toThrow();
  });
});

describe('newestChunkId', () => {
  it('reads the newest chunk of any tag or format, and nothing else', async () => {
    const dir = await tempDir();
    expect(await newestChunkId(path.join(dir, 'missing'))).toBeNull();
    for (const name of [
      'chnk_01ARZ3NDEKTSV4RRFFQ69G5FAV.bin',
      'chnk_01ARZ3NDEKTSV4RRFFQ69G5FAW.vitest-0.bin',
      'chnk_01ARZ3NDEKTSV4RRFFQ69G5FAX.json',
      'chnk_02.bin',
      '.0b8e6c2e-tmp.tmp',
      'notes.txt',
    ]) {
      await fs.writeFile(path.join(dir, name), '');
    }
    expect(await newestChunkId(dir)).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAX');
  });
});

describe('where a stream chunk lands', () => {
  it('a chunk whose writer stalled after naming it lands after the chunks other writers landed meanwhile, where every reader puts it', async () => {
    const dir = await tempDir();
    const name = 'takeover';
    // Two writers and a reader, each its own streamer, as each in its own
    // process.
    const first = createStreamer(dir);
    const second = createStreamer(dir);
    const reader = createStreamer(dir);
    await first.streams.write(TEST_RUN_ID, name, 'a1');
    const live = await follow(reader, name);

    // The first writer's next chunk stalls just before it lands, with the
    // name it chose: at the link that lands it, or the rename that did
    // before chunks were named as they land.
    let named: string | undefined;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stall = async (from: unknown, to: unknown) => {
      if (
        named === undefined &&
        path.basename(String(to)).startsWith('chnk_') &&
        (await textOf(from)) === 'a2'
      ) {
        named = String(to);
        await released;
      }
    };
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      await stall(from, to);
      return realLink(from, to);
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await stall(from, to);
      return realRename(from, to);
    });
    const late = first.streams.write(TEST_RUN_ID, name, 'a2');
    for (let waited = 0; named === undefined && waited < 5000; waited += 10) {
      await sleep(10);
    }
    expect(named).toBeDefined();

    // Meanwhile the second writer lands its chunks, and the reader has them.
    await second.streams.write(TEST_RUN_ID, name, 'b1');
    await second.streams.write(TEST_RUN_ID, name, 'b2');
    await live.until(3);
    expect(live.chunks).toEqual(['a1', 'b1', 'b2']);

    release();
    await late;
    await second.streams.write(TEST_RUN_ID, name, 'b3');
    await live.until(5);
    await live.stop();
    expect(await replayOf(reader, name)).toEqual([
      'a1',
      'b1',
      'b2',
      'a2',
      'b3',
    ]);
    expect(live.chunks).toEqual(await replayOf(reader, name));
    // The second writer took the name the first chose.
    expect(await textOf(named)).toBe('b1');
  });

  it('writers in other processes racing for one stream land every chunk once, where every reader puts it', async () => {
    const dir = await tempDir();
    const name = 'race';
    const reader = createStreamer(dir);
    await reader.streams.write(TEST_RUN_ID, name, 'start\n');
    const child = fileURLToPath(
      new URL('./stream-chunk-place.child.mjs', import.meta.url)
    );
    const writers = ['w0', 'w1', 'w2', 'w3'].map((tag) => {
      const proc = fork(child, [dir, TEST_RUN_ID, name, tag, '40'], {
        // Node's own type stripping, nothing inherited from the test runner.
        execArgv: [],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const said: { status: string; message?: string }[] = [];
      const waiting: ((message: { status: string }) => void)[] = [];
      proc.on('message', (message) => {
        const said_ = message as { status: string };
        const next = waiting.shift();
        if (next) next(said_);
        else said.push(said_);
      });
      const next = () =>
        new Promise<{ status: string; message?: string }>((resolve) => {
          const queued = said.shift();
          if (queued) resolve(queued);
          else waiting.push(resolve);
        });
      return { proc, next };
    });
    for (const writer of writers) {
      expect((await writer.next()).status).toBe('ready');
    }
    const live = await follow(reader, name);
    for (const writer of writers) writer.proc.send('go');
    for (const writer of writers) {
      expect(await writer.next()).toEqual({ status: 'done' });
    }
    await live.until(161);
    await live.stop();
    const replay = await replayOf(reader, name);
    expect(replay).toHaveLength(161);
    expect(new Set(replay).size).toBe(161);
    expect(live.chunks).toEqual(replay);
    for (const tag of ['w0', 'w1', 'w2', 'w3']) {
      const own = replay.filter((text) => text.startsWith(`${tag}-`));
      expect(own).toEqual(own.map((_, index) => `${tag}-${index}\n`));
    }
  }, 30_000);

  it("one streamer's writes to a stream land in the order they were called", async () => {
    const dir = await tempDir();
    const streamer = createStreamer(dir);
    const name = 'order';
    let resolveRunId!: (runId: string) => void;
    const later = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });
    // The first write waits for its run id, and the batch's first chunk is
    // the largest: neither lands ahead of a write called before it.
    const writes = [
      streamer.streams.write(later, name, 'one'),
      streamer.streams.write(TEST_RUN_ID, name, 'two'),
      streamer.streams.writeMulti(TEST_RUN_ID, name, [
        'three'.repeat(1 << 18),
        'four',
        'five',
      ]),
      streamer.streams.close(TEST_RUN_ID, name),
    ];
    await sleep(50);
    expect(await replayOf(streamer, name)).toEqual([]);
    resolveRunId(TEST_RUN_ID);
    await Promise.all(writes);
    expect(
      (await replayOf(streamer, name)).map((text) => text.slice(0, 5))
    ).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect((await streamer.streams.getChunks(TEST_RUN_ID, name)).done).toBe(
      true
    );
    // A stream's first chunk sorts after the tombstone a purge leaves.
    const files = await fs.readdir(path.join(dir, 'streams', 'chunks', name));
    expect(files.sort()[0]).toBe(`chnk_${'0'.repeat(25)}1.bin`);
  });

  it('a write that fails before it lands does not let a later write land ahead of an earlier one', async () => {
    const dir = await tempDir();
    const streamer = createStreamer(dir);
    const name = 'failed-turn';
    let resolveRunId!: (runId: string) => void;
    const later = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });
    const first = streamer.streams.write(later, name, 'one');
    // Fails at once, while the first write still waits for its run id.
    const failed = streamer.streams.write('not a run id/..', name, 'lost');
    const third = streamer.streams.write(TEST_RUN_ID, name, 'three');
    await expect(failed).rejects.toThrow();
    await sleep(50);
    expect(await replayOf(streamer, name)).toEqual([]);
    resolveRunId(TEST_RUN_ID);
    await Promise.all([first, third]);
    expect(await replayOf(streamer, name)).toEqual(['one', 'three']);
  });

  it('a write whose link fails for another reason fails, leaves no temporary file, and the stream goes on', async () => {
    const dir = await tempDir();
    const name = 'link-fails';
    const streamer = createStreamer(dir);
    await streamer.streams.write(TEST_RUN_ID, name, 'one');
    // As on a file system that makes no hard links: there is no fallback,
    // since a rename there could replace a chunk another writer landed.
    const unsupported: NodeJS.ErrnoException = new Error(
      'operation not supported'
    );
    unsupported.code = 'ENOTSUP';
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(unsupported);
    await expect(
      streamer.streams.write(TEST_RUN_ID, name, 'lost')
    ).rejects.toThrow('operation not supported');
    link.mockRestore();
    await streamer.streams.write(TEST_RUN_ID, name, 'two');
    expect(await replayOf(streamer, name)).toEqual(['one', 'two']);
    const files = await fs.readdir(path.join(dir, 'streams', 'chunks', name));
    expect(files.sort()).toEqual([
      `chnk_${'0'.repeat(25)}1.bin`,
      `chnk_${'0'.repeat(25)}2.bin`,
    ]);
  });
});
