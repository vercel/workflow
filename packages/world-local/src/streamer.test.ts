import { fork } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { databaseFor } from './db/index.js';
import { createStreamer } from './streamer.js';

const TEST_RUN_ID = 'wrun_test12345678901234';

/** A fresh data directory and a streamer on it, removed after the test. */
async function setupStreamer(tag?: string) {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-stream-'));
  onTestFinished(async () => {
    databaseFor(testDir).close();
    await fs.rm(testDir, { recursive: true, force: true });
  });
  return { testDir, streamer: createStreamer(testDir, tag) };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function readText(stream: ReadableStream<Uint8Array>) {
  return (await readAll(stream)).map((chunk) => Buffer.from(chunk).toString());
}

/** Reads `stream` in the background, collecting chunks as they arrive. */
function collect(stream: ReadableStream<Uint8Array>) {
  const received: string[] = [];
  const done = (async () => {
    for await (const chunk of stream) {
      received.push(Buffer.from(chunk).toString());
    }
  })();
  return { received, done };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Long enough for an unordered write or delivery to land first.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Tracks the intervals created from here on and whether each was cleared:
 * counting the process's active timers instead would also count unrelated
 * timers that start or end meanwhile.
 */
function trackIntervals() {
  const created = new Set<unknown>();
  const cleared = new Set<unknown>();
  const set = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    ...args: Parameters<typeof setInterval>
  ) => {
    const handle = setIntervalOriginal(...args);
    created.add(handle);
    return handle;
  }) as typeof setInterval);
  const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
    handle: Parameters<typeof clearInterval>[0]
  ) => {
    cleared.add(handle);
    clearIntervalOriginal(handle);
  }) as typeof clearInterval);
  return {
    open: () => [...created].filter((handle) => !cleared.has(handle)).length,
    restore() {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}
const setIntervalOriginal = globalThis.setInterval;
const clearIntervalOriginal = globalThis.clearInterval;

/** Listeners on the streamer's in-process wake-up signal, across all streams. */
function signalListeners() {
  const signals = (globalThis as Record<symbol, unknown>)[
    Symbol.for('@workflow/world-local//streamSignals/v1')
  ] as { emitter: EventEmitter } | undefined;
  if (!signals) return 0;
  return signals.emitter
    .eventNames()
    .reduce((sum, event) => sum + signals.emitter.listenerCount(event), 0);
}

describe('streamer', () => {
  describe('write and read', () => {
    it('round-trips string chunks', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'string-stream';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'hello ');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'world');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['hello ', 'world']);
    });

    it('round-trips Buffer chunks', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'buffer-stream';

      await streamer.streams.write(
        TEST_RUN_ID,
        streamName,
        Buffer.from('chunk1')
      );
      await streamer.streams.write(
        TEST_RUN_ID,
        streamName,
        Buffer.from('chunk2')
      );
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['chunk1', 'chunk2']);
    });

    it('round-trips binary data byte for byte', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'binary-stream';

      await streamer.streams.write(
        TEST_RUN_ID,
        streamName,
        new Uint8Array([0, 1, 2, 255])
      );
      await streamer.streams.write(
        TEST_RUN_ID,
        streamName,
        new Uint8Array([254, 253, 0, 6])
      );
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const chunks = await readAll(
        await streamer.streams.get(TEST_RUN_ID, streamName)
      );
      expect(chunks.map((chunk) => Array.from(chunk))).toEqual([
        [0, 1, 2, 255],
        [254, 253, 0, 6],
      ]);
    });

    it('preserves multi-byte UTF-8 strings', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'utf8-stream';
      const text = 'special chars: ñáéíóú ✓ 😀';

      await streamer.streams.write(TEST_RUN_ID, streamName, text);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const [chunk] = await readAll(
        await streamer.streams.get(TEST_RUN_ID, streamName)
      );
      expect(new TextDecoder().decode(chunk)).toBe(text);
    });

    it('keeps streams independent', async () => {
      const { streamer } = await setupStreamer();

      await streamer.streams.write(TEST_RUN_ID, 'stream1', 'data1');
      await streamer.streams.write(TEST_RUN_ID, 'stream2', 'data2');
      await streamer.streams.write(TEST_RUN_ID, 'stream1', 'data3');
      await streamer.streams.close(TEST_RUN_ID, 'stream1');
      await streamer.streams.close(TEST_RUN_ID, 'stream2');

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, 'stream1'))
      ).toEqual(['data1', 'data3']);
      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, 'stream2'))
      ).toEqual(['data2']);
    });

    it('resumes with startIndex after a cancelled read (reproduces vibe platform bug)', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'resumption-stream';

      for (let i = 0; i < 4; i++) {
        await streamer.streams.write(TEST_RUN_ID, streamName, `chunk${i}`);
      }

      // First read, interrupted after 2 chunks while the stream is open.
      const reader1 = (
        await streamer.streams.get(TEST_RUN_ID, streamName, 0)
      ).getReader();
      const result1 = await reader1.read();
      const result2 = await reader1.read();
      expect(Buffer.from(result1.value ?? []).toString()).toBe('chunk0');
      expect(Buffer.from(result2.value ?? []).toString()).toBe('chunk1');
      await reader1.cancel();

      await streamer.streams.close(TEST_RUN_ID, streamName);

      // Every delivered chunk must be usable (not a detached ArrayBuffer).
      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName, 2))
      ).toEqual(['chunk2', 'chunk3']);
    });

    it('reads the same chunks from every instance on the data directory', async () => {
      const { testDir, streamer } = await setupStreamer();
      const other = createStreamer(testDir);
      const streamName = 'cross-instance';

      // A live reader on the second instance, opened before any write.
      const live = collect(await other.streams.get(TEST_RUN_ID, streamName));
      await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, ['b', 'c']);
      await streamer.streams.close(TEST_RUN_ID, streamName);
      await live.done;
      expect(live.received).toEqual(['a', 'b', 'c']);

      // And a fresh instance sees the finished stream.
      const fresh = createStreamer(testDir);
      expect(
        await readText(await fresh.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['a', 'b', 'c']);
      const page = await fresh.streams.getChunks(TEST_RUN_ID, streamName);
      expect(page.data.map((c) => Buffer.from(c.data).toString())).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(page.done).toBe(true);
      expect(await fresh.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 2,
        done: true,
      });
      expect(await fresh.streams.list(TEST_RUN_ID)).toEqual([streamName]);
    });
  });

  describe('writeMulti', () => {
    it('preserves chunk ordering', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'ordered-multi-stream';

      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, [
        'first',
        'second',
        'third',
      ]);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['first', 'second', 'third']);
    });

    it('writes nothing for an empty chunks array', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'empty-multi-stream';

      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, []);

      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: -1,
        done: false,
      });
      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([]);
    });

    it('handles mixed string and Uint8Array chunks', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'mixed-multi-stream';

      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, [
        'string-chunk',
        new Uint8Array([1, 2, 3, 4]),
        Buffer.from('buffer-chunk'),
      ]);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const chunks = await readAll(
        await streamer.streams.get(TEST_RUN_ID, streamName)
      );
      expect(chunks).toHaveLength(3);
      expect(new TextDecoder().decode(chunks[0])).toBe('string-chunk');
      expect(Array.from(chunks[1])).toEqual([1, 2, 3, 4]);
      expect(new TextDecoder().decode(chunks[2])).toBe('buffer-chunk');
    });

    it('lands a group whole and in order for a reader that opens mid-write', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'write-multi-order';
      await streamer.streams.write(TEST_RUN_ID, streamName, 'zero\n');
      const runId = deferred<string>();

      const writing = streamer.streams.writeMulti(runId.promise, streamName, [
        'first\n',
        'second\n',
        'third\n',
      ]);
      await settle();
      // The reader opens while the group is still waiting to be written.
      const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
      runId.resolve(TEST_RUN_ID);
      await writing;
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await readText(stream)).toEqual([
        'zero\n',
        'first\n',
        'second\n',
        'third\n',
      ]);
    });

    it('keeps each group contiguous when instances write at once', async () => {
      const { testDir, streamer } = await setupStreamer();
      const other = createStreamer(testDir);
      const streamName = 'write-multi-groups';
      const stream = await streamer.streams.get(TEST_RUN_ID, streamName);

      await Promise.all([
        streamer.streams.writeMulti(TEST_RUN_ID, streamName, [
          'a0',
          'a1',
          'a2',
        ]),
        other.streams.writeMulti(TEST_RUN_ID, streamName, ['b0', 'b1', 'b2']),
        streamer.streams.writeMulti(TEST_RUN_ID, streamName, [
          'c0',
          'c1',
          'c2',
        ]),
      ]);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const received = await readText(stream);
      expect(received).toHaveLength(9);
      // Groups never interleave, and one instance's groups keep call order.
      const groups = [0, 3, 6].map((i) => received.slice(i, i + 3));
      for (const group of groups) {
        const prefix = group[0][0];
        expect(group).toEqual([`${prefix}0`, `${prefix}1`, `${prefix}2`]);
      }
      const prefixes = groups.map((group) => group[0][0]);
      expect(prefixes.indexOf('a')).toBeLessThan(prefixes.indexOf('c'));
      expect([...prefixes].sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('close', () => {
    it('closes a stream with no chunks', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'empty-stream';

      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual([]);
      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: -1,
        done: true,
      });
      const page = await streamer.streams.getChunks(TEST_RUN_ID, streamName);
      expect(page.data).toEqual([]);
      expect(page.done).toBe(true);
    });

    it('closes a stream with existing chunks', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'existing-stream';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk2');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 1,
        done: true,
      });
      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['chunk1', 'chunk2']);
    });

    it('closing twice is harmless', async () => {
      const { testDir, streamer } = await setupStreamer();
      const other = createStreamer(testDir);
      const streamName = 'double-close';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'data');
      await streamer.streams.close(TEST_RUN_ID, streamName);
      await expect(
        streamer.streams.close(TEST_RUN_ID, streamName)
      ).resolves.toBeUndefined();
      await expect(
        other.streams.close(TEST_RUN_ID, streamName)
      ).resolves.toBeUndefined();

      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 0,
        done: true,
      });
      const page = await streamer.streams.getChunks(TEST_RUN_ID, streamName);
      expect(page.data.map((c) => Buffer.from(c.data).toString())).toEqual([
        'data',
      ]);
      expect(page.done).toBe(true);
      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['data']);
    });

    it('ends a live reader when the stream closes', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'live-close';
      const live = collect(await streamer.streams.get(TEST_RUN_ID, streamName));

      await streamer.streams.write(TEST_RUN_ID, streamName, 'one');
      await waitFor(() => live.received.length === 1);
      await streamer.streams.close(TEST_RUN_ID, streamName);
      await live.done;

      expect(live.received).toEqual(['one']);
    });

    it('closes a stream behind a write still waiting for its run id', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'close-behind-write';
      const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
      const runId = deferred<string>();

      const writing = streamer.streams.write(
        runId.promise,
        streamName,
        'data\n'
      );
      const closing = streamer.streams.close(TEST_RUN_ID, streamName);
      await Promise.race([closing, settle()]);
      runId.resolve(TEST_RUN_ID);
      await Promise.all([writing, closing]);

      expect(await readText(stream)).toEqual(['data\n']);
    });
  });

  describe('get with startIndex', () => {
    async function writeChunks(
      streamer: ReturnType<typeof createStreamer>,
      streamName: string,
      count: number,
      { close = true } = {}
    ) {
      for (let i = 0; i < count; i++) {
        await streamer.streams.write(TEST_RUN_ID, streamName, `chunk${i}`);
      }
      if (close) await streamer.streams.close(TEST_RUN_ID, streamName);
    }

    it('skips that many chunks from the start', async () => {
      const { streamer } = await setupStreamer();
      await writeChunks(streamer, 'positive', 4);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, 'positive', 1))
      ).toEqual(['chunk1', 'chunk2', 'chunk3']);
    });

    it('ends at once when it starts past the tail of a finished stream', async () => {
      const { streamer } = await setupStreamer();
      await writeChunks(streamer, 'past-tail', 2);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, 'past-tail', 5))
      ).toEqual([]);
    });

    it('supports a negative startIndex to read from the end', async () => {
      const { streamer } = await setupStreamer();
      await writeChunks(streamer, 'negative', 4);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, 'negative', -2))
      ).toEqual(['chunk2', 'chunk3']);
    });

    it('resolves a negative startIndex against an open stream, then reads live', async () => {
      const { streamer } = await setupStreamer();
      await writeChunks(streamer, 'negative-open', 3, { close: false });

      const stream = await streamer.streams.get(
        TEST_RUN_ID,
        'negative-open',
        -1
      );
      await streamer.streams.write(TEST_RUN_ID, 'negative-open', 'chunk3');
      await streamer.streams.close(TEST_RUN_ID, 'negative-open');

      expect(await readText(stream)).toEqual(['chunk2', 'chunk3']);
    });

    it('clamps a negative startIndex beyond the chunk count to 0', async () => {
      const { streamer } = await setupStreamer();
      await writeChunks(streamer, 'negative-clamped', 2);

      expect(
        await readText(
          await streamer.streams.get(TEST_RUN_ID, 'negative-clamped', -100)
        )
      ).toEqual(['chunk0', 'chunk1']);
    });

    it('never delivers a chunk before startIndex, even one written live', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'start-index-live';

      const stream = await streamer.streams.get(TEST_RUN_ID, streamName, 1);
      await streamer.streams.write(TEST_RUN_ID, streamName, 'c0\n');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'c1\n');
      await settle();
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await readText(stream)).toEqual(['c1\n']);
    });
  });

  describe('chunk order', () => {
    it('lands concurrent writes in the order they were called', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'concurrent-write-order';
      const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
      const runId = deferred<string>();

      const first = streamer.streams.write(
        runId.promise,
        streamName,
        'first\n'
      );
      const second = streamer.streams.write(
        TEST_RUN_ID,
        streamName,
        'second\n'
      );
      await Promise.race([second, settle()]);
      runId.resolve(TEST_RUN_ID);
      await Promise.all([first, second]);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await readText(stream)).toEqual(['first\n', 'second\n']);
    });

    it('lands many writes issued at once in call order', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'burst-order';
      const expected = Array.from({ length: 50 }, (_, i) => `${i}\n`);

      await Promise.all(
        expected.map((chunk) =>
          streamer.streams.write(TEST_RUN_ID, streamName, chunk)
        )
      );
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(expected);
    });

    it('does not lose or duplicate chunks written while a reader opens', async () => {
      for (let iteration = 0; iteration < 3; iteration++) {
        const { streamer } = await setupStreamer();
        const streamName = `race-${iteration}`;

        await streamer.streams.write(TEST_RUN_ID, streamName, '0\n');
        await streamer.streams.write(TEST_RUN_ID, streamName, '1\n');

        // Keep writing while the reader opens.
        const writeTask = (async () => {
          for (let i = 2; i < 10; i++) {
            await streamer.streams.write(TEST_RUN_ID, streamName, `${i}\n`);
          }
          await streamer.streams.close(TEST_RUN_ID, streamName);
        })();

        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const chunks = await readText(stream);
        await writeTask;

        expect(chunks).toEqual(Array.from({ length: 10 }, (_, i) => `${i}\n`));
      }
    });

    it('keeps order when chunks arrive while a reader is catching up', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'ordering-test';

      for (let i = 0; i < 5; i++) {
        await streamer.streams.write(TEST_RUN_ID, streamName, `${i}\n`);
      }

      const live = collect(await streamer.streams.get(TEST_RUN_ID, streamName));
      for (let i = 5; i < 10; i++) {
        await streamer.streams.write(TEST_RUN_ID, streamName, `${i}\n`);
      }
      await streamer.streams.close(TEST_RUN_ID, streamName);
      await live.done;

      expect(live.received.join('')).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
    });

    it('delivers writes from two instances in commit order', async () => {
      const { testDir, streamer } = await setupStreamer();
      const other = createStreamer(testDir);
      const streamName = 'two-writers';
      const live = collect(await streamer.streams.get(TEST_RUN_ID, streamName));

      await streamer.streams.write(TEST_RUN_ID, streamName, '0\n');
      await other.streams.write(TEST_RUN_ID, streamName, '1\n');
      await settle();
      await other.streams.write(TEST_RUN_ID, streamName, '2\n');
      await streamer.streams.write(TEST_RUN_ID, streamName, '3\n');
      await other.streams.close(TEST_RUN_ID, streamName);
      await live.done;

      expect(live.received).toEqual(['0\n', '1\n', '2\n', '3\n']);
    });
  });

  describe('reader lifecycle (vercel/workflow#2795, #2797)', () => {
    it('tears down signal listeners and the poll interval on cancel', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'teardown-stream';
      // Open the database first so its own timers are counted in `before`.
      await streamer.streams.getInfo(TEST_RUN_ID, streamName);
      const intervals = trackIntervals();
      onTestFinished(() => intervals.restore());
      const listenersBefore = signalListeners();

      // A reader on a stream with no chunks (the abort-stream shape) waits
      // on the signal and the poll.
      const reader = (
        await streamer.streams.get(TEST_RUN_ID, streamName)
      ).getReader();
      const pending = reader.read();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(signalListeners()).toBe(listenersBefore + 1);
      expect(intervals.open()).toBe(1);

      await reader.cancel();
      await pending.catch(() => {});

      expect(intervals.open()).toBe(0);
      expect(signalListeners()).toBe(listenersBefore);
      // A later write must not reach the cancelled reader.
      await expect(
        streamer.streams.write(TEST_RUN_ID, streamName, 'after-cancel')
      ).resolves.toBeUndefined();
    });

    it('tears down signal listeners and the poll interval at the end of the stream', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'teardown-at-end';
      await streamer.streams.getInfo(TEST_RUN_ID, streamName);
      const intervals = trackIntervals();
      onTestFinished(() => intervals.restore());
      const listenersBefore = signalListeners();

      const live = collect(await streamer.streams.get(TEST_RUN_ID, streamName));
      await streamer.streams.write(TEST_RUN_ID, streamName, 'data');
      await streamer.streams.close(TEST_RUN_ID, streamName);
      await live.done;

      expect(live.received).toEqual(['data']);
      expect(intervals.open()).toBe(0);
      expect(signalListeners()).toBe(listenersBefore);
    });

    it('reads only the stream asked for, however busy the others are', async () => {
      const { streamer } = await setupStreamer();

      await streamer.streams.write(TEST_RUN_ID, 'target', 'hi');
      await streamer.streams.writeMulti(
        TEST_RUN_ID,
        'noise',
        Array.from({ length: 2000 }, (_, i) => `noise${i}`)
      );

      expect(await streamer.streams.getInfo(TEST_RUN_ID, 'target')).toEqual({
        tailIndex: 0,
        done: false,
      });
      const { data } = await streamer.streams.getChunks(TEST_RUN_ID, 'target');
      expect(data.map((c) => Buffer.from(c.data).toString())).toEqual(['hi']);
    });
  });

  describe('runId as a promise', () => {
    it('holds writes until the run id resolves, then writes them in order', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'promise-runid-test';
      const runId = deferred<string>();

      let writes1Complete = false;
      let writes2Complete = false;
      const writePromise1 = streamer.streams
        .write(runId.promise, streamName, 'chunk1\n')
        .then(() => {
          writes1Complete = true;
        });
      const writePromise2 = streamer.streams
        .write(runId.promise, streamName, 'chunk2\n')
        .then(() => {
          writes2Complete = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(writes1Complete).toBe(false);
      expect(writes2Complete).toBe(false);
      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: -1,
        done: false,
      });

      runId.resolve(TEST_RUN_ID);
      await writePromise1;
      await writePromise2;

      const closeRunId = deferred<string>();
      const closePromise = streamer.streams.close(
        closeRunId.promise,
        streamName
      );
      closeRunId.resolve(TEST_RUN_ID);
      await closePromise;

      expect(
        await readText(await streamer.streams.get(TEST_RUN_ID, streamName))
      ).toEqual(['chunk1\n', 'chunk2\n']);
      // The resolved run id is the one the stream is listed under.
      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([streamName]);
    });
  });

  describe('list', () => {
    it('returns an empty array when no streams exist', async () => {
      const { streamer } = await setupStreamer();

      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([]);
    });

    it('returns the streams of the run', async () => {
      const { streamer } = await setupStreamer();
      const streamName1 = 'my-stdout-stream';
      const streamName2 = 'my-stderr-stream';

      await streamer.streams.write(TEST_RUN_ID, streamName1, 'stdout output');
      await streamer.streams.write(TEST_RUN_ID, streamName2, 'stderr output');
      await streamer.streams.close(TEST_RUN_ID, streamName1);
      await streamer.streams.close(TEST_RUN_ID, streamName2);

      expect((await streamer.streams.list(TEST_RUN_ID)).sort()).toEqual(
        [streamName1, streamName2].sort()
      );
    });

    it('does not return streams of other runs', async () => {
      const { streamer } = await setupStreamer();
      const otherRunId = 'wrun_other1234567890123';

      await streamer.streams.write(TEST_RUN_ID, 'target-stdout', 'target');
      await streamer.streams.write(otherRunId, 'other-stdout', 'other');

      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([
        'target-stdout',
      ]);
      expect(await streamer.streams.list(otherRunId)).toEqual(['other-stdout']);
    });

    it('returns each stream name once, however many chunks it has', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'chunked-output';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, [
        'chunk2',
        'chunk3',
      ]);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([streamName]);
    });

    it('handles stream names with dashes', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'my-complex-stream-name';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'data');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([streamName]);
    });

    it('lists a stream that was only closed', async () => {
      const { streamer } = await setupStreamer();

      await streamer.streams.close(TEST_RUN_ID, 'close-only-stream');

      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([
        'close-only-stream',
      ]);
    });

    describe('concurrent first writes', () => {
      const names = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

      it('keeps every name when many streams of a run first write at once', async () => {
        const { streamer } = await setupStreamer();
        const streamNames = names('stream', 20);

        await Promise.all(
          streamNames.map((name) =>
            streamer.streams.write(TEST_RUN_ID, name, 'data')
          )
        );

        expect((await streamer.streams.list(TEST_RUN_ID)).sort()).toEqual(
          [...streamNames].sort()
        );
      });

      it('keeps every name across write, writeMulti and close', async () => {
        const { streamer } = await setupStreamer();

        await Promise.all([
          streamer.streams.write(TEST_RUN_ID, 'written-0', 'a'),
          streamer.streams.writeMulti(TEST_RUN_ID, 'multi-0', ['a', 'b']),
          streamer.streams.close(TEST_RUN_ID, 'closed-0'),
          streamer.streams.write(TEST_RUN_ID, 'written-1', 'a'),
          streamer.streams.writeMulti(TEST_RUN_ID, 'multi-1', ['a', 'b']),
          streamer.streams.close(TEST_RUN_ID, 'closed-1'),
        ]);

        expect((await streamer.streams.list(TEST_RUN_ID)).sort()).toEqual([
          'closed-0',
          'closed-1',
          'multi-0',
          'multi-1',
          'written-0',
          'written-1',
        ]);
      });

      it.each([
        { label: 'untagged', tag: undefined },
        { label: 'tagged', tag: 'vitest-x' },
      ])('keeps every name when two streamers share the data directory ($label)', async ({
        tag,
      }) => {
        const { testDir } = await setupStreamer();
        const first = createStreamer(testDir, tag);
        const second = createStreamer(testDir, tag);

        for (let i = 0; i < 10; i++) {
          const runId = `wrun_shared${i}`;
          const firstNames = names('first', 3);
          const secondNames = names('second', 3);
          await Promise.all([
            ...firstNames.map((name) => first.streams.write(runId, name, 'a')),
            ...secondNames.map((name) =>
              second.streams.write(runId, name, 'b')
            ),
          ]);

          expect((await first.streams.list(runId)).sort()).toEqual(
            [...firstNames, ...secondNames].sort()
          );
        }
      });
    });
  });

  describe('getChunks', () => {
    it('paginates through all chunks', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'paginated-stream';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'b');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'c');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const page1 = await streamer.streams.getChunks(TEST_RUN_ID, streamName, {
        limit: 2,
      });
      expect(page1.data.map((c) => c.index)).toEqual([0, 1]);
      expect(page1.data.map((c) => Buffer.from(c.data).toString())).toEqual([
        'a',
        'b',
      ]);
      expect(page1.hasMore).toBe(true);
      expect(page1.done).toBe(false);
      expect(page1.cursor).not.toBeNull();

      const page2 = await streamer.streams.getChunks(TEST_RUN_ID, streamName, {
        limit: 2,
        cursor: page1.cursor ?? undefined,
      });
      expect(page2.data.map((c) => c.index)).toEqual([2]);
      expect(Buffer.from(page2.data[0].data).toString()).toBe('c');
      expect(page2.hasMore).toBe(false);
      expect(page2.cursor).toBeNull();
      expect(page2.done).toBe(true);
    });

    it('reports done on a page that ends exactly at the end of the stream', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'exact-page';

      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, ['a', 'b']);
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const page = await streamer.streams.getChunks(TEST_RUN_ID, streamName, {
        limit: 2,
      });
      expect(page.data).toHaveLength(2);
      expect(page.hasMore).toBe(false);
      expect(page.cursor).toBeNull();
      expect(page.done).toBe(true);
    });

    it('continues from a cursor as an open stream grows', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'growing';

      await streamer.streams.writeMulti(TEST_RUN_ID, streamName, ['a', 'b']);
      const page1 = await streamer.streams.getChunks(TEST_RUN_ID, streamName, {
        limit: 1,
      });
      expect(page1.hasMore).toBe(true);

      await streamer.streams.write(TEST_RUN_ID, streamName, 'c');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const page2 = await streamer.streams.getChunks(TEST_RUN_ID, streamName, {
        cursor: page1.cursor ?? undefined,
      });
      expect(page2.data.map((c) => c.index)).toEqual([1, 2]);
      expect(page2.data.map((c) => Buffer.from(c.data).toString())).toEqual([
        'b',
        'c',
      ]);
      expect(page2.done).toBe(true);
    });

    it('returns done=false for an in-progress stream', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'in-progress';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'data');

      const result = await streamer.streams.getChunks(TEST_RUN_ID, streamName);
      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.done).toBe(false);
    });

    it('returns empty data for a nonexistent stream', async () => {
      const { streamer } = await setupStreamer();

      const result = await streamer.streams.getChunks(
        TEST_RUN_ID,
        'nonexistent'
      );
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
      expect(result.done).toBe(false);
    });

    it('restarts from the beginning on an invalid cursor', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'bad-cursor';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'data');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      const result = await streamer.streams.getChunks(TEST_RUN_ID, streamName, {
        cursor: 'not-valid-base64-json',
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].index).toBe(0);
    });
  });

  describe('getInfo', () => {
    it('returns tailIndex and done for a completed stream', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'info-completed';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'b');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 1,
        done: true,
      });
    });

    it('returns tailIndex for an in-progress stream', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'info-progress';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
      await streamer.streams.write(TEST_RUN_ID, streamName, 'b');

      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 1,
        done: false,
      });
    });

    it('returns -1 for a nonexistent stream', async () => {
      const { streamer } = await setupStreamer();

      expect(
        await streamer.streams.getInfo(TEST_RUN_ID, 'nonexistent')
      ).toEqual({ tailIndex: -1, done: false });
    });

    it('returns tailIndex 0 for a single-chunk stream', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'single-chunk';

      await streamer.streams.write(TEST_RUN_ID, streamName, 'only');
      await streamer.streams.close(TEST_RUN_ID, streamName);

      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 0,
        done: true,
      });
    });
  });

  describe('across OS processes on one data directory', () => {
    const child = fileURLToPath(
      new URL('./streamer-writer.child.mjs', import.meta.url)
    );
    type Answer = { status: 'ready' | 'done' | 'error'; message?: string };

    /** A process writing `name` on `testDir` as the test directs it. */
    async function otherProcess(testDir: string, name: string) {
      const proc = fork(child, [testDir, TEST_RUN_ID, name], {
        // Node's own type stripping, nothing inherited from the test runner.
        execArgv: [],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const exited = new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
      });
      onTestFinished(async () => {
        if (proc.exitCode === null) proc.kill();
        await exited;
      });
      const next = () =>
        new Promise<Answer>((resolve, reject) => {
          const onExit = (code: number | null) =>
            reject(new Error(`child exited (${code}) without answering`));
          proc.once('exit', onExit);
          proc.once('message', (m) => {
            proc.off('exit', onExit);
            resolve(m as Answer);
          });
        });
      expect(await next()).toEqual({ status: 'ready' });
      const send = async (message: object) => {
        const answer = next();
        proc.send(message);
        const result = await answer;
        if (result.status !== 'done') {
          throw new Error(`child failed: ${result.message}`);
        }
      };
      return {
        write: (chunks: string[]) => send({ op: 'write', chunks }),
        writeMulti: (chunks: string[]) => send({ op: 'writeMulti', chunks }),
        close: async () => {
          await send({ op: 'close' });
          await exited;
        },
      };
    }

    it('reads a stream written by another process live and in order', async () => {
      const { testDir, streamer } = await setupStreamer();
      const streamName = 'other-process';
      const writer = await otherProcess(testDir, streamName);
      const live = collect(await streamer.streams.get(TEST_RUN_ID, streamName));

      await writer.write(['0\n', '1\n', '2\n']);
      // Delivered while the stream is still open: the reader is live.
      await waitFor(() => live.received.length === 3);
      expect(live.received).toEqual(['0\n', '1\n', '2\n']);

      await writer.writeMulti(['3\n', '4\n', '5\n']);
      await waitFor(() => live.received.length === 6);
      await writer.write(['6\n']);
      await writer.close();
      await live.done;

      expect(live.received).toEqual(
        Array.from({ length: 7 }, (_, i) => `${i}\n`)
      );
      expect(await streamer.streams.getInfo(TEST_RUN_ID, streamName)).toEqual({
        tailIndex: 6,
        done: true,
      });
      expect(await streamer.streams.list(TEST_RUN_ID)).toEqual([streamName]);
    }, 20_000);
  });
});
