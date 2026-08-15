import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { decodeTime } from 'ulid';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createStreamer,
  deserializeChunk,
  serializeChunk,
} from './streamer.js';

const TEST_RUN_ID = 'wrun_test12345678901234';
const childDir = process.env.WORKFLOW_LOCAL_KEYED_STREAM_CHILD_DIR;
const childMarker = process.env.WORKFLOW_LOCAL_KEYED_STREAM_CHILD_MARKER;

if (childDir && childMarker) {
  describe('keyed stream child writer', () => {
    it('writes through an independent process', async () => {
      const result = await createStreamer(childDir).streams.appendKeyed!(
        TEST_RUN_ID,
        'strm_keyed_child_process',
        {
          idempotencyKey: 'child-key',
          semanticDigest: 'child-digest',
          chunk: new TextEncoder().encode('child'),
        }
      );
      await fs.writeFile(childMarker, JSON.stringify(result));
    });
  });
}

describe('streamer', () => {
  describe('serializeChunk and deserializeChunk', () => {
    it('should serialize and deserialize non-EOF chunks correctly', () => {
      const input = { eof: false, chunk: Buffer.from('hello world') };
      const serialized = serializeChunk(input);
      const deserialized = deserializeChunk(serialized);

      expect(deserialized).toEqual(input);
    });

    it('should serialize and deserialize EOF chunks correctly', () => {
      const input = { eof: true, chunk: Buffer.from('final data') };
      const serialized = serializeChunk(input);
      const deserialized = deserializeChunk(serialized);

      expect(deserialized).toEqual(input);
    });

    it('should handle empty chunks', () => {
      const input = { eof: false, chunk: Buffer.from([]) };
      const serialized = serializeChunk(input);
      const deserialized = deserializeChunk(serialized);

      expect(deserialized).toEqual(input);
    });

    it('should handle empty EOF chunks', () => {
      const input = { eof: true, chunk: Buffer.from([]) };
      const serialized = serializeChunk(input);
      const deserialized = deserializeChunk(serialized);

      expect(deserialized).toEqual(input);
    });

    it('should handle binary data', () => {
      const binaryData = Buffer.from([0, 1, 2, 255, 254, 253]);
      const input = { eof: false, chunk: binaryData };
      const serialized = serializeChunk(input);
      const deserialized = deserializeChunk(serialized);

      expect(deserialized).toEqual(input);
    });

    it('should preserve buffer contents exactly', () => {
      const originalData = Buffer.from('test data with special chars: ñáéíóú');
      const input = { eof: false, chunk: originalData };
      const serialized = serializeChunk(input);
      const deserialized = deserializeChunk(serialized);

      expect(deserialized.chunk.equals(originalData)).toBe(true);
      expect(deserialized.eof).toBe(false);
    });

    it('should create correct binary format (1 byte EOF + chunk data)', () => {
      const chunkData = Buffer.from('test');
      const input = { eof: false, chunk: chunkData };
      const serialized = serializeChunk(input);

      // First byte should be 0 (false)
      expect(serialized[0]).toBe(0);
      // Rest should be the chunk data
      expect(serialized.subarray(1)).toEqual(chunkData);

      const eofInput = { eof: true, chunk: chunkData };
      const eofSerialized = serializeChunk(eofInput);

      // First byte should be 1 (true)
      expect(eofSerialized[0]).toBe(1);
      // Rest should be the chunk data
      expect(eofSerialized.subarray(1)).toEqual(chunkData);
    });
  });

  describe('createStreamer', () => {
    async function setupStreamer({
      cleanupTimeout,
    }: {
      cleanupTimeout?: number;
    } = {}) {
      const testDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'streamer-test-')
      );
      const streamer = createStreamer(testDir);

      onTestFinished(async (ctx) => {
        if (!ctx.task.result?.errors?.length) {
          await fs.rm(testDir, { recursive: true, force: true });
        } else {
          const chunksPath = `${testDir}/streams/chunks`;
          // Chunks are sharded one directory per stream:
          // streams/chunks/<streamName>/<chunkId><tagSuffix>.bin
          let files: string[];
          try {
            const streamDirs = await fs.readdir(chunksPath);
            files = (
              await Promise.all(
                streamDirs.map(async (streamDir) =>
                  (
                    await fs.readdir(`${chunksPath}/${streamDir}`)
                  ).map((f) => `${streamDir}/${f}`)
                )
              )
            ).flat();
          } catch {
            // chunks directory may not exist if the test failed before any writes
            files = [];
          }
          const chunks = [] as unknown[];
          let lastTime = 0;
          for (const file of files) {
            const chunk = deserializeChunk(
              await fs.readFile(`${chunksPath}/${file}`)
            );
            // Filename is "<chunkId><tagSuffix>.bin"; chunkId is "chnk_ULID".
            const ulid = String(file.split('/').at(-1))
              .split('.')[0]
              .replace('chnk_', '');
            const time = decodeTime(ulid);
            const timeDiff = time - lastTime;
            lastTime = time;

            chunks.push({
              file,
              timeDiff,
              eof: chunk.eof,
              text: chunk.chunk.toString('utf8'),
            });
          }
          console.log(
            `Test failed, here are the chunks that were generated`,
            chunks
          );
        }
      }, cleanupTimeout);

      return {
        testDir,
        streamer,
      };
    }

    it('keeps keyed append v1 unavailable until the complete terminal matrix is proven', async () => {
      const { streamer } = await setupStreamer();

      expect(streamer).not.toHaveProperty('keyedStreamAppendVersion');
    });

    it('rejects converting ordinary stream data to keyed mode', async () => {
      const { streamer } = await setupStreamer();
      await streamer.streams.write(TEST_RUN_ID, 'strm_keyed_mixed', 'ordinary');

      await expect(
        streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_mixed', {
          idempotencyKey: 'key-1',
          semanticDigest: 'digest-1',
          chunk: 'keyed',
        })
      ).rejects.toThrow('mixed keyed/unkeyed');
    });

    it('rejects ordinary writes after keyed mode is established', async () => {
      const { streamer } = await setupStreamer();
      await streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_mixed', {
        idempotencyKey: 'key-1',
        semanticDigest: 'digest-1',
        chunk: 'keyed',
      });

      await expect(
        streamer.streams.write(TEST_RUN_ID, 'strm_keyed_mixed', 'ordinary')
      ).rejects.toThrow('mixed keyed/unkeyed');
    });

    it('admits exactly one mode when ordinary and keyed first writes race', async () => {
      const { testDir } = await setupStreamer();
      const name = 'strm_keyed_mode_race';
      const ordinary = createStreamer(testDir);
      const keyed = createStreamer(testDir);

      const results = await Promise.allSettled([
        ordinary.streams.write(TEST_RUN_ID, name, 'ordinary'),
        keyed.streams.appendKeyed!(TEST_RUN_ID, name, {
          idempotencyKey: 'key-1',
          semanticDigest: 'digest-1',
          chunk: 'keyed',
        }),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      const restarted = createStreamer(testDir);
      const chunks = await restarted.streams.getChunks(TEST_RUN_ID, name);
      expect(chunks.data).toHaveLength(1);
      await restarted.streams.close(TEST_RUN_ID, name);
      expect((await restarted.streams.getChunks(TEST_RUN_ID, name)).done).toBe(
        true
      );
    });

    it('persists keyed EOF and rejects append after close', async () => {
      const { streamer } = await setupStreamer();
      await streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_eof', {
        idempotencyKey: 'key-1',
        semanticDigest: 'digest-1',
        chunk: 'keyed',
      });
      await streamer.streams.close(TEST_RUN_ID, 'strm_keyed_eof');

      await expect(
        streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_eof', {
          idempotencyKey: 'key-2',
          semanticDigest: 'digest-2',
          chunk: 'late',
        })
      ).rejects.toThrow('closed keyed stream');
      expect(
        await streamer.streams.getInfo(TEST_RUN_ID, 'strm_keyed_eof')
      ).toEqual({ tailIndex: 0, done: true });
    });

    it('adopts one ordinary EOF when independent streamers close concurrently', async () => {
      const { testDir } = await setupStreamer();
      const name = 'strm_ordinary_single_eof';
      const first = createStreamer(testDir);
      const second = createStreamer(testDir);
      await first.streams.write(TEST_RUN_ID, name, 'data');

      await Promise.all([
        first.streams.close(TEST_RUN_ID, name),
        second.streams.close(TEST_RUN_ID, name),
      ]);

      const chunkDir = path.join(testDir, 'streams', 'chunks', name);
      const chunks = await Promise.all(
        (await fs.readdir(chunkDir)).map(async (file) =>
          deserializeChunk(await fs.readFile(path.join(chunkDir, file)))
        )
      );
      expect(chunks.filter((chunk) => chunk.eof)).toHaveLength(1);
      expect(
        await createStreamer(testDir).streams.getChunks(TEST_RUN_ID, name)
      ).toMatchObject({
        done: true,
        data: [{ data: new TextEncoder().encode('data'), index: 0 }],
      });
    });

    it('rejects ordinary writes after its canonical close', async () => {
      const { streamer } = await setupStreamer();
      const name = 'strm_ordinary_closed';
      await streamer.streams.close(TEST_RUN_ID, name);

      await expect(
        streamer.streams.write(TEST_RUN_ID, name, 'late')
      ).rejects.toThrow('closed ordinary stream');
    });

    it('serializes different keyed writers from independent streamers by run and stream', async () => {
      const { testDir } = await setupStreamer();
      const first = createStreamer(testDir);
      const second = createStreamer(testDir);
      const streamName = 'strm_keyed_two_writers';
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? first : second).streams.appendKeyed!(
            TEST_RUN_ID,
            streamName,
            {
              idempotencyKey: `key-${index}`,
              semanticDigest: `digest-${index}`,
              chunk: new TextEncoder().encode(String(index)),
            }
          )
        )
      );

      expect(
        [...results.map((result) => result.index)].sort((a, b) => a - b)
      ).toEqual(Array.from({ length: 20 }, (_, index) => index));
      expect(
        (await first.streams.getChunks(TEST_RUN_ID, streamName)).data.map(
          ({ data }) => new TextDecoder().decode(data)
        )
      ).toEqual(
        results
          .sort((a, b) => a.index - b.index)
          .map((result) => new TextDecoder().decode(result.canonicalChunk))
      );
    });

    it('converges equal keys and rejects divergent keys across independent streamers', async () => {
      const { testDir } = await setupStreamer();
      const first = createStreamer(testDir);
      const second = createStreamer(testDir);
      const request = {
        idempotencyKey: 'same-key',
        semanticDigest: 'same-digest',
        chunk: new TextEncoder().encode('canonical'),
      };
      const [left, right] = await Promise.all([
        first.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_converge', request),
        second.streams.appendKeyed!(
          TEST_RUN_ID,
          'strm_keyed_converge',
          request
        ),
      ]);
      expect([left, right].filter(({ inserted }) => inserted)).toHaveLength(1);
      expect(left.index).toBe(0);
      expect(right.index).toBe(0);
      await expect(
        second.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_converge', {
          ...request,
          semanticDigest: 'different-digest',
        })
      ).rejects.toThrow('different digest');
    });

    it('delivers a live keyed append from another streamer through filesystem polling', async () => {
      const { testDir } = await setupStreamer();
      const reader = (
        await createStreamer(testDir).streams.get(
          TEST_RUN_ID,
          'strm_keyed_live'
        )
      ).getReader();
      const reading = reader.read();
      await createStreamer(testDir).streams.appendKeyed!(
        TEST_RUN_ID,
        'strm_keyed_live',
        {
          idempotencyKey: 'live-key',
          semanticDigest: 'live-digest',
          chunk: new TextEncoder().encode('live'),
        }
      );
      await expect(reading).resolves.toMatchObject({
        done: false,
        value: new TextEncoder().encode('live'),
      });
      await reader.cancel();
    });

    it('keeps keyed receipts isolated for distinct runs sharing stream and key', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'strm_keyed_run_isolation';
      const first = await streamer.streams.appendKeyed!(
        TEST_RUN_ID,
        streamName,
        {
          idempotencyKey: 'same-key',
          semanticDigest: 'first',
          chunk: new TextEncoder().encode('first'),
        }
      );
      const second = await streamer.streams.appendKeyed!(
        'wrun_other1234567890123',
        streamName,
        {
          idempotencyKey: 'same-key',
          semanticDigest: 'second',
          chunk: new TextEncoder().encode('second'),
        }
      );

      expect(first).toMatchObject({ inserted: true, index: 0 });
      expect(second).toMatchObject({ inserted: true, index: 0 });
      expect(
        (
          await streamer.streams.getChunks(
            'wrun_other1234567890123',
            streamName
          )
        ).data
      ).toEqual([{ index: 0, data: new TextEncoder().encode('second') }]);
    });

    it('orders a real second-process writer with the local writer', async () => {
      const { testDir, streamer } = await setupStreamer();
      const marker = path.join(testDir, 'child-result.json');
      const child = spawn(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          'packages/world-local/src/streamer.test.ts',
          '--testNamePattern',
          'writes through an independent process',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            WORKFLOW_LOCAL_KEYED_STREAM_CHILD_DIR: testDir,
            WORKFLOW_LOCAL_KEYED_STREAM_CHILD_MARKER: marker,
          },
          stdio: 'ignore',
        }
      );
      const parent = streamer.streams.appendKeyed!(
        TEST_RUN_ID,
        'strm_keyed_child_process',
        {
          idempotencyKey: 'parent-key',
          semanticDigest: 'parent-digest',
          chunk: new TextEncoder().encode('parent'),
        }
      );
      await new Promise<void>((resolve, reject) =>
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`child exited ${code}`))
        )
      );
      await parent;
      expect(JSON.parse(await fs.readFile(marker, 'utf8')).index).toBeTypeOf(
        'number'
      );
      expect(
        (
          await streamer.streams.getChunks(
            TEST_RUN_ID,
            'strm_keyed_child_process'
          )
        ).data
          .map(({ data }) => new TextDecoder().decode(data))
          .sort()
      ).toEqual(['child', 'parent']);
    }, 20_000);

    it('repairs a missing physical chunk only from its canonical ledger record', async () => {
      const { testDir, streamer } = await setupStreamer();
      const streamName = 'strm_keyed_repair';
      const first = await streamer.streams.appendKeyed!(
        TEST_RUN_ID,
        streamName,
        {
          idempotencyKey: 'repair-key',
          semanticDigest: 'repair-digest',
          chunk: new TextEncoder().encode('canonical'),
        }
      );
      const [file] = await fs.readdir(
        path.join(testDir, 'streams', 'chunks', streamName)
      );
      await fs.unlink(
        path.join(testDir, 'streams', 'chunks', streamName, file)
      );
      await expect(
        createStreamer(testDir).streams.appendKeyed!(TEST_RUN_ID, streamName, {
          idempotencyKey: 'repair-key',
          semanticDigest: 'repair-digest',
          chunk: new TextEncoder().encode('replacement'),
        })
      ).resolves.toEqual({
        inserted: false,
        canonicalChunk: new TextEncoder().encode('canonical'),
        index: first.index,
      });
    });

    it('fails closed on a corrupt keyed ledger', async () => {
      const { testDir, streamer } = await setupStreamer();
      await streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_corrupt', {
        idempotencyKey: 'key',
        semanticDigest: 'digest',
        chunk: new Uint8Array([1]),
      });
      const runDir = path.join(testDir, 'streams', 'keyed-v1');
      const [run] = await fs.readdir(runDir);
      const [ledger] = await fs.readdir(path.join(runDir, run));
      await fs.writeFile(
        path.join(runDir, run, ledger),
        '{"version":1,"records":[]}'
      );
      await expect(
        streamer.streams.getChunks(TEST_RUN_ID, 'strm_keyed_corrupt')
      ).rejects.toThrow();
    });

    it('returns the original keyed receipt after a response-loss retry without another chunk', async () => {
      const { streamer } = await setupStreamer();
      const first = await streamer.streams.appendKeyed!(
        TEST_RUN_ID,
        'strm_keyed',
        {
          idempotencyKey: 'eve-public-event/v1/run/step/0',
          semanticDigest: 'digest-a',
          chunk: new Uint8Array([1, 2, 3]),
        }
      );
      const retry = await streamer.streams.appendKeyed!(
        TEST_RUN_ID,
        'strm_keyed',
        {
          idempotencyKey: 'eve-public-event/v1/run/step/0',
          semanticDigest: 'digest-a',
          chunk: new Uint8Array([9]),
        }
      );

      expect(first).toEqual({
        inserted: true,
        canonicalChunk: new Uint8Array([1, 2, 3]),
        index: 0,
      });
      expect(retry).toEqual({
        inserted: false,
        canonicalChunk: new Uint8Array([1, 2, 3]),
        index: 0,
      });
      expect(
        (await streamer.streams.getChunks(TEST_RUN_ID, 'strm_keyed')).data
      ).toEqual([{ index: 0, data: new Uint8Array([1, 2, 3]) }]);
    });

    it('delivers a first keyed insertion once to an already-following local reader', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'strm_keyed_follower';
      const reader = (
        await streamer.streams.get(TEST_RUN_ID, streamName)
      ).getReader();
      const firstRead = reader.read();

      // Let the reader install its local event subscription before publishing.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await streamer.streams.appendKeyed!(TEST_RUN_ID, streamName, {
        idempotencyKey: 'eve-public-event/v1/run/step/0',
        semanticDigest: 'digest-a',
        chunk: new TextEncoder().encode('first'),
      });
      await expect(firstRead).resolves.toMatchObject({
        done: false,
        value: new TextEncoder().encode('first'),
      });

      const secondRead = reader.read();
      await streamer.streams.appendKeyed!(TEST_RUN_ID, streamName, {
        idempotencyKey: 'eve-public-event/v1/run/step/0',
        semanticDigest: 'digest-a',
        chunk: new TextEncoder().encode('retry payload ignored'),
      });
      await expect(
        streamer.streams.appendKeyed!(TEST_RUN_ID, streamName, {
          idempotencyKey: 'eve-public-event/v1/run/step/0',
          semanticDigest: 'digest-mismatch',
          chunk: new TextEncoder().encode('mismatch'),
        })
      ).rejects.toThrow('different digest');
      await streamer.streams.appendKeyed!(TEST_RUN_ID, streamName, {
        idempotencyKey: 'eve-public-event/v1/run/step/1',
        semanticDigest: 'digest-b',
        chunk: new TextEncoder().encode('second'),
      });
      await expect(secondRead).resolves.toMatchObject({
        done: false,
        value: new TextEncoder().encode('second'),
      });
      await reader.cancel();
    });

    it('replays keyed chunks to a late local follower in receipt order', async () => {
      const { streamer } = await setupStreamer();
      const streamName = 'strm_keyed_replay_order';
      const encoder = new TextEncoder();
      const events = [
        'session.started\n',
        'turn.started\n',
        'session.waiting\n',
      ];

      for (const [index, event] of events.entries()) {
        await streamer.streams.appendKeyed!(TEST_RUN_ID, streamName, {
          idempotencyKey: `eve-public-event/v1/run/step/${index}`,
          semanticDigest: `digest-${index}`,
          chunk: encoder.encode(event),
        });
      }

      const reader = (
        await streamer.streams.get(TEST_RUN_ID, streamName)
      ).getReader();
      const received = await Promise.all([
        reader.read(),
        reader.read(),
        reader.read(),
      ]);
      await reader.cancel();

      expect(
        received.map(({ value }) => new TextDecoder().decode(value))
      ).toEqual(['session.started\n', 'turn.started\n', 'session.waiting\n']);
    });

    it('rejects a keyed retry with a different digest', async () => {
      const { streamer } = await setupStreamer();
      await streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_conflict', {
        idempotencyKey: 'eve-public-event/v1/run/step/0',
        semanticDigest: 'digest-a',
        chunk: new Uint8Array([1]),
      });

      await expect(
        streamer.streams.appendKeyed!(TEST_RUN_ID, 'strm_keyed_conflict', {
          idempotencyKey: 'eve-public-event/v1/run/step/0',
          semanticDigest: 'digest-b',
          chunk: new Uint8Array([2]),
        })
      ).rejects.toThrow('different digest');
    });

    it('allocates one indexed chunk under concurrent keyed calls and preserves it after restart', async () => {
      const { streamer, testDir } = await setupStreamer();
      const request = {
        idempotencyKey: 'eve-public-event/v1/run/step/0',
        semanticDigest: 'digest-a',
        chunk: new Uint8Array([8]),
      };
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () =>
          streamer.streams.appendKeyed!(
            TEST_RUN_ID,
            'strm_keyed_restart',
            request
          )
        )
      );
      expect(receipts.filter((receipt) => receipt.inserted)).toHaveLength(1);
      expect(receipts.every((receipt) => receipt.index === 0)).toBe(true);

      const restarted = createStreamer(testDir);
      await expect(
        restarted.streams.appendKeyed!(
          TEST_RUN_ID,
          'strm_keyed_restart',
          request
        )
      ).resolves.toEqual({
        inserted: false,
        canonicalChunk: new Uint8Array([8]),
        index: 0,
      });
      expect(
        (await restarted.streams.getChunks(TEST_RUN_ID, 'strm_keyed_restart'))
          .data
      ).toEqual([{ index: 0, data: new Uint8Array([8]) }]);
    });

    describe('streams.write', () => {
      it('should write string chunks to a stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'test-stream';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'hello');
        await streamer.streams.write(TEST_RUN_ID, streamName, ' world');

        // Verify the per-stream chunk directory was created
        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(2);
        expect(files.every((f) => f.startsWith('chnk_'))).toBe(true);
        expect(files.every((f) => f.endsWith('.bin'))).toBe(true);
      });

      it('should write Buffer chunks to a stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'buffer-stream';
        const buffer1 = Buffer.from('chunk1');
        const buffer2 = Buffer.from('chunk2');

        await streamer.streams.write(TEST_RUN_ID, streamName, buffer1);
        await streamer.streams.write(TEST_RUN_ID, streamName, buffer2);

        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(2);
        expect(files.every((f) => f.startsWith('chnk_'))).toBe(true);
      });

      it('should write Uint8Array chunks to a stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'uint8-stream';
        const uint8Array = new Uint8Array([1, 2, 3, 4]);

        await streamer.streams.write(TEST_RUN_ID, streamName, uint8Array);

        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(1);
        expect(files[0]).toMatch('chnk_');
      });

      it('should handle multiple streams independently', async () => {
        const { testDir, streamer } = await setupStreamer();

        await streamer.streams.write(TEST_RUN_ID, 'stream1', 'data1');
        await streamer.streams.write(TEST_RUN_ID, 'stream2', 'data2');
        await streamer.streams.write(TEST_RUN_ID, 'stream1', 'data3');

        // Each stream gets its own sharded directory.
        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const stream1Files = await fs.readdir(path.join(chunksDir, 'stream1'));
        const stream2Files = await fs.readdir(path.join(chunksDir, 'stream2'));

        expect(stream1Files).toHaveLength(2);
        expect(stream2Files).toHaveLength(1);
      });
    });

    describe('streams.writeMulti', () => {
      it('should write multiple chunks in a single call', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'multi-stream';

        await streamer.streams.writeMulti!(TEST_RUN_ID, streamName, [
          'chunk1',
          'chunk2',
          'chunk3',
        ]);

        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(3);
        expect(files.every((f) => f.startsWith('chnk_'))).toBe(true);
      });

      it('should preserve chunk ordering', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'ordered-multi-stream';

        await streamer.streams.writeMulti!(TEST_RUN_ID, streamName, [
          'first',
          'second',
          'third',
        ]);
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const readable = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        const chunks: string[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value));
        }

        expect(chunks).toEqual(['first', 'second', 'third']);
      });

      it('should handle empty chunks array', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'empty-multi-stream';

        await streamer.streams.writeMulti!(TEST_RUN_ID, streamName, []);

        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const dirExists = await fs
          .access(chunksDir)
          .then(() => true)
          .catch(() => false);

        // Directory might not exist if no chunks were written
        if (dirExists) {
          const files = await fs.readdir(chunksDir);
          expect(files).toHaveLength(0);
        }
      });

      it('should handle mixed string and Uint8Array chunks', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'mixed-multi-stream';

        await streamer.streams.writeMulti!(TEST_RUN_ID, streamName, [
          'string-chunk',
          new Uint8Array([1, 2, 3, 4]),
          Buffer.from('buffer-chunk'),
        ]);
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const readable = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = readable.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        expect(chunks).toHaveLength(3);
        expect(new TextDecoder().decode(chunks[0])).toBe('string-chunk');
        expect(chunks[1]).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(new TextDecoder().decode(chunks[2])).toBe('buffer-chunk');
      });
    });

    describe('streams.close', () => {
      it('should close an empty stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'empty-stream';

        await streamer.streams.close(TEST_RUN_ID, streamName);

        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(1);
        expect(files[0]).toMatch('chnk_');
      });

      it('should close a stream with existing chunks', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'existing-stream';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk2');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(3); // 2 data chunks + 1 EOF chunk
      });
    });

    describe('streams.get', () => {
      it('should read chunks from a completed stream', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'read-stream';
        const chunk1 = 'hello ';
        const chunk2 = 'world';

        await streamer.streams.write(TEST_RUN_ID, streamName, chunk1);
        // Add a small delay to ensure different ULID timestamps
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, chunk2);
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = stream.getReader();

        const chunks: Uint8Array[] = [];
        let done = false;

        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            chunks.push(result.value);
          }
        }

        const combined = Buffer.concat(chunks).toString();
        expect(combined).toBe('hello world');
      });

      it('should read binary data correctly', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'binary-stream';
        const binaryData1 = new Uint8Array([1, 2, 3]);
        const binaryData2 = new Uint8Array([4, 5, 6]);

        await streamer.streams.write(TEST_RUN_ID, streamName, binaryData1);
        // Add delay to ensure different ULID timestamps
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, binaryData2);
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = stream.getReader();

        const chunks: Uint8Array[] = [];
        let done = false;

        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            chunks.push(result.value);
          }
        }

        const combined = new Uint8Array(
          chunks.reduce((acc, chunk) => acc + chunk.length, 0)
        );
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }

        expect(Array.from(combined)).toEqual([1, 2, 3, 4, 5, 6]);
      });

      it('should preserve chunk order based on ULID timestamps', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'ordered-stream';

        // Write chunks with small delays to ensure different ULID timestamps
        await streamer.streams.write(TEST_RUN_ID, streamName, '1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, '2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, '3');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = stream.getReader();

        const chunks: string[] = [];
        let done = false;

        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            chunks.push(Buffer.from(result.value).toString());
          }
        }

        expect(chunks.join('')).toBe('123');
      });

      it('should handle stream resumption with startIndex after cancellation (reproduces vibe platform bug)', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'resumption-stream';

        // Write multiple chunks to simulate a DurableAgent streaming output
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk0');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk3');

        // First read: Simulate initial connection that gets interrupted after 2 chunks
        // Note: Stream is NOT closed yet - simulates reading while workflow is still running
        const stream1 = await streamer.streams.get(TEST_RUN_ID, streamName, 0);
        const reader1 = stream1.getReader();

        // Read first 2 chunks
        const result1 = await reader1.read();
        const result2 = await reader1.read();
        expect(Buffer.from(result1.value!).toString()).toBe('chunk0');
        expect(Buffer.from(result2.value!).toString()).toBe('chunk1');

        // Cancel the first stream (simulating connection loss / timeout)
        await reader1.cancel();

        // Workflow continues and finishes
        await streamer.streams.close(TEST_RUN_ID, streamName);

        // Second read: Resume from startIndex=2 (this is where ArrayBuffer detachment bug occurs)
        // Without the fix, this would fail with "Cannot perform Construct on a detached ArrayBuffer"
        const stream2 = await streamer.streams.get(TEST_RUN_ID, streamName, 2);
        const reader2 = stream2.getReader();

        const chunks: string[] = [];
        let done = false;

        while (!done) {
          const result = await reader2.read();
          done = result.done;
          if (result.value) {
            // This operation would fail if ArrayBuffer is detached
            chunks.push(Buffer.from(result.value).toString());
          }
        }

        // Should successfully read remaining chunks
        expect(chunks.join('')).toBe('chunk2chunk3');
      });

      it('should support negative startIndex to read from the end', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'negative-index-stream';

        // Write 4 chunks
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk0');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk3');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        // Read with startIndex=-2 → last 2 chunks
        const stream = await streamer.streams.get(TEST_RUN_ID, streamName, -2);
        const reader = stream.getReader();

        const chunks: string[] = [];
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            chunks.push(Buffer.from(result.value).toString());
          }
        }

        expect(chunks.join('')).toBe('chunk2chunk3');
      });

      it('should clamp negative startIndex that exceeds chunk count to 0', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'negative-clamped-stream';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk0');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        // -100 exceeds total count, should clamp to 0 and return all chunks
        const stream = await streamer.streams.get(
          TEST_RUN_ID,
          streamName,
          -100
        );
        const reader = stream.getReader();

        const chunks: string[] = [];
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            chunks.push(Buffer.from(result.value).toString());
          }
        }

        expect(chunks.join('')).toBe('chunk0chunk1');
      });
    });

    describe('cross-process polling', () => {
      it('should deliver chunks via filesystem polling when EventEmitter is bypassed', async () => {
        // Simulate cross-process streaming: write chunk files directly to
        // disk (bypassing streamer.streams.write and thus the EventEmitter)
        // and verify the polling-based reader picks them up.
        const testDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'streamer-poll-test-')
        );
        onTestFinished(async (ctx) => {
          if (!ctx.task.result?.errors?.length) {
            await fs.rm(testDir, { recursive: true, force: true });
          }
        });

        const streamer = createStreamer(testDir);
        const streamName = 'poll-test';
        // Simulate a cross-process writer landing chunks straight on disk in
        // the stream's sharded directory.
        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        await fs.mkdir(chunksDir, { recursive: true });

        // Start reading — sets up EventEmitter listeners + polling interval
        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = stream.getReader();
        const chunks: string[] = [];

        const readPromise = (async () => {
          let done = false;
          while (!done) {
            const result = await reader.read();
            done = result.done;
            if (result.value) {
              chunks.push(Buffer.from(result.value).toString());
            }
          }
        })();

        // Let polling start
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Write chunk files directly — no EventEmitter involved
        const chunk1 = serializeChunk({
          eof: false,
          chunk: Buffer.from('hello'),
        });
        await fs.writeFile(
          path.join(chunksDir, `chnk_01ARZ3NDEKTSV4RRFFQ69G5FAV.bin`),
          chunk1
        );

        await new Promise((resolve) => setTimeout(resolve, 200));

        const chunk2 = serializeChunk({
          eof: false,
          chunk: Buffer.from(' world'),
        });
        await fs.writeFile(
          path.join(chunksDir, `chnk_01ARZ3NDEKTSV4RRFFQ69G5FAW.bin`),
          chunk2
        );

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Write EOF chunk to close the stream
        const eofChunk = serializeChunk({
          eof: true,
          chunk: Buffer.from([]),
        });
        await fs.writeFile(
          path.join(chunksDir, `chnk_01ARZ3NDEKTSV4RRFFQ69G5FAX.bin`),
          eofChunk
        );

        await readPromise;

        expect(chunks.join('')).toBe('hello world');
      }, 10000);
    });

    describe('reader lifecycle (vercel/workflow#2795, #2797)', () => {
      it('tears down emitter listeners and the poll interval on cancel', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'teardown-stream';

        // Open a reader on a stream with no chunks (the abort-stream shape):
        // start() reads an empty directory, then arms the 100ms poll and
        // registers chunk/close emitter listeners.
        const before = process
          .getActiveResourcesInfo()
          .filter((r) => r === 'Timeout').length;

        const readable = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = readable.getReader();
        // Kick off a read so start() runs to completion (arms the poll).
        const pending = reader.read();
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Cancelling must release everything the reader holds open.
        await reader.cancel();
        await pending.catch(() => {});

        const after = process
          .getActiveResourcesInfo()
          .filter((r) => r === 'Timeout').length;
        expect(after).toBeLessThanOrEqual(before);

        // A subsequent write must not reach the cancelled reader's listeners
        // (a leaked listener would still try to enqueue on a closed stream).
        await expect(
          streamer.streams.write(TEST_RUN_ID, streamName, 'after-cancel')
        ).resolves.toBeUndefined();
      });

      it('scopes chunk listing to the stream, not the whole world', async () => {
        const { testDir, streamer } = await setupStreamer({
          // Removing the 2,000-file fixture can exceed Vitest's default hook
          // timeout on Windows runners.
          cleanupTimeout: 30_000,
        });

        // One real chunk on the stream under test.
        await streamer.streams.write(TEST_RUN_ID, 'target', 'hi');

        // Thousands of unrelated chunks in *other* streams. Under the old flat
        // layout these all lived in one directory and every tail-reader poll
        // re-listed them (O(world chunks)); now each stream is sharded so the
        // target's listing is unaffected.
        const chunksBase = path.join(testDir, 'streams', 'chunks');
        const otherDir = path.join(chunksBase, 'noise');
        await fs.mkdir(otherDir, { recursive: true });
        await Promise.all(
          Array.from({ length: 2000 }, (_, i) =>
            fs.writeFile(path.join(otherDir, `chnk_seed${i}.bin`), '')
          )
        );

        // The target stream's own directory holds exactly its one chunk.
        const targetEntries = await fs.readdir(path.join(chunksBase, 'target'));
        expect(targetEntries).toHaveLength(1);

        // And reads return only the target's data, never the noise.
        const info = await streamer.streams.getInfo(TEST_RUN_ID, 'target');
        expect(info.tailIndex).toBe(0);
        const { data } = await streamer.streams.getChunks(
          TEST_RUN_ID,
          'target'
        );
        expect(data).toHaveLength(1);
        expect(Buffer.from(data[0].data).toString()).toBe('hi');
      });
    });

    describe('integration scenarios', () => {
      it('should handle complete write-close-read cycle', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'integration-stream';

        // Write chunks with proper timing
        await streamer.streams.write(TEST_RUN_ID, streamName, 'start ');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'middle ');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'end');

        // Close the stream
        await streamer.streams.close(TEST_RUN_ID, streamName);

        // Read complete stream
        const completeStream = await streamer.streams.get(
          TEST_RUN_ID,
          streamName
        );
        const completeReader = completeStream.getReader();
        const completeChunks: Uint8Array[] = [];
        let completeDone = false;

        while (!completeDone) {
          const completeResult = await completeReader.read();
          completeDone = completeResult.done;
          if (completeResult.value) {
            completeChunks.push(completeResult.value);
          }
        }

        const completeContent = Buffer.concat(completeChunks).toString();
        expect(completeContent).toBe('start middle end');
      });

      it('should not lose or duplicate chunks written during stream initialization (race condition test)', async () => {
        // Run multiple iterations to increase probability of catching race conditions.
        // Keep the count low — each iteration creates a fresh streamer with its own
        // temp directory, and per-chunk I/O on Windows CI can be ~100-200ms which
        // easily blows the timeout at higher counts.
        for (let iteration = 0; iteration < 3; iteration++) {
          const { streamer } = await setupStreamer();
          const streamName = `race-${iteration}`;

          // Write a few chunks to disk first
          await streamer.streams.write(TEST_RUN_ID, streamName, '0\n');
          await streamer.streams.write(TEST_RUN_ID, streamName, '1\n');

          // Start writing chunks in background IMMEDIATELY before reading
          const writeTask = (async () => {
            for (let i = 2; i < 10; i++) {
              await streamer.streams.write(TEST_RUN_ID, streamName, `${i}\n`);
              // No delay - fire them off as fast as possible to hit the race window
            }
            await streamer.streams.close(TEST_RUN_ID, streamName);
          })();

          // Start reading - this triggers start() which should set up listeners
          // BEFORE listing files to avoid missing chunks, and track delivered
          // chunk IDs to avoid duplicates
          const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
          const reader = stream.getReader();
          const chunks: string[] = [];

          let done = false;
          while (!done) {
            const result = await reader.read();
            done = result.done;
            if (result.value) {
              chunks.push(Buffer.from(result.value).toString());
            }
          }

          await writeTask;

          // Verify exactly 10 chunks were received (no duplicates, no missing)
          const content = chunks.join('');
          const lines = content.split('\n').filter((l) => l !== '');

          // Check for duplicates
          if (lines.length !== 10) {
            const numbers = lines.map(Number);
            throw new Error(
              `Expected 10 chunks but got ${lines.length}. ` +
                (lines.length > 10
                  ? 'Duplicates detected!'
                  : 'Missing chunks!') +
                ` Received: ${numbers.join(',')}`
            );
          }

          // Check all numbers 0-9 are present
          const numbers = lines.map(Number).sort((a, b) => a - b);
          for (let i = 0; i < 10; i++) {
            if (numbers[i] !== i) {
              throw new Error(
                `Race condition detected! Missing or incorrect chunk at position ${i}. ` +
                  `Expected ${i}, got ${numbers[i]}. Full list: ${numbers.join(',')}`
              );
            }
          }
        }
      }, 20000);

      it('should maintain chronological order when chunks arrive during disk reading', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'ordering-test';

        // Write chunks 0-4 to disk
        for (let i = 0; i < 5; i++) {
          await streamer.streams.write(TEST_RUN_ID, streamName, `${i}\n`);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }

        // Start reading
        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = stream.getReader();
        const chunks: string[] = [];

        const readPromise = (async () => {
          let done = false;
          while (!done) {
            const result = await reader.read();
            done = result.done;
            if (result.value) {
              chunks.push(Buffer.from(result.value).toString());
            }
          }
        })();

        // Immediately write more chunks (5-9) while disk reading might be in progress
        for (let i = 5; i < 10; i++) {
          await streamer.streams.write(TEST_RUN_ID, streamName, `${i}\n`);
        }

        await streamer.streams.close(TEST_RUN_ID, streamName);
        await readPromise;

        // Verify chunks are in exact chronological order (not just all present)
        const content = chunks.join('');
        expect(content).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
      });
    });

    describe('streams.list', () => {
      it('should return empty array when no streams exist', async () => {
        const { streamer } = await setupStreamer();

        const streams = await streamer.streams.list(TEST_RUN_ID);
        expect(streams).toEqual([]);
      });

      it('should return streams associated with the runId', async () => {
        const { streamer } = await setupStreamer();

        // Stream names can be anything - they're tracked via explicit mapping
        const streamName1 = 'my-stdout-stream';
        const streamName2 = 'my-stderr-stream';

        await streamer.streams.write(TEST_RUN_ID, streamName1, 'stdout output');
        await streamer.streams.write(TEST_RUN_ID, streamName2, 'stderr output');
        await streamer.streams.close(TEST_RUN_ID, streamName1);
        await streamer.streams.close(TEST_RUN_ID, streamName2);

        const streams = await streamer.streams.list(TEST_RUN_ID);

        expect(streams).toHaveLength(2);
        expect(streams).toContain(streamName1);
        expect(streams).toContain(streamName2);
      });

      it('should not return streams from different runIds', async () => {
        const { streamer } = await setupStreamer();

        const otherRunId = 'wrun_other1234567890123';

        const targetStream = 'target-stdout';
        const otherStream = 'other-stdout';

        await streamer.streams.write(
          TEST_RUN_ID,
          targetStream,
          'target output'
        );
        await streamer.streams.write(otherRunId, otherStream, 'other output');

        const streams = await streamer.streams.list(TEST_RUN_ID);

        expect(streams).toHaveLength(1);
        expect(streams).toContain(targetStream);
        expect(streams).not.toContain(otherStream);

        // Also verify the other run has only its stream
        const otherStreams = await streamer.streams.list(otherRunId);
        expect(otherStreams).toHaveLength(1);
        expect(otherStreams).toContain(otherStream);
      });

      it('should return unique stream names even with multiple chunks', async () => {
        const { streamer } = await setupStreamer();

        const streamName = 'chunked-output';

        // Write multiple chunks to the same stream
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'chunk3');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const streams = await streamer.streams.list(TEST_RUN_ID);

        // Should only return the stream name once, not once per chunk
        expect(streams).toHaveLength(1);
        expect(streams).toContain(streamName);
      });

      it('should handle stream names with dashes', async () => {
        const { streamer } = await setupStreamer();

        const streamName = 'my-complex-stream-name';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'data');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const streams = await streamer.streams.list(TEST_RUN_ID);

        expect(streams).toHaveLength(1);
        expect(streams).toContain(streamName);
      });

      it('should register stream even if only close is called', async () => {
        const { streamer } = await setupStreamer();

        const streamName = 'close-only-stream';

        // Only call close without write
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const streams = await streamer.streams.list(TEST_RUN_ID);

        expect(streams).toHaveLength(1);
        expect(streams).toContain(streamName);
      });
    });

    describe('getChunks', () => {
      it('should paginate through all chunks', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'paginated-stream';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'b');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'c');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        // Page 1: limit=2
        const page1 = await streamer.streams.getChunks(
          TEST_RUN_ID,
          streamName,
          {
            limit: 2,
          }
        );
        expect(page1.data).toHaveLength(2);
        expect(page1.data[0].index).toBe(0);
        expect(page1.data[1].index).toBe(1);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).not.toBeNull();

        // Page 2: remaining chunks
        const page2 = await streamer.streams.getChunks(
          TEST_RUN_ID,
          streamName,
          {
            limit: 2,
            cursor: page1.cursor!,
          }
        );
        expect(page2.data).toHaveLength(1);
        expect(page2.data[0].index).toBe(2);
        expect(page2.hasMore).toBe(false);
        expect(page2.done).toBe(true);
      });

      it('prefers tagged chunks over untagged and legacy files', async () => {
        const { testDir } = await setupStreamer();
        const streamName = 'mixed-format-stream';
        const taggedStreamer = createStreamer(testDir, 'vitest-0');
        // Chunks live in the stream's sharded directory; the filename is just
        // the chunk id plus its format/tag suffix (no stream-name prefix).
        const chunksDir = path.join(testDir, 'streams', 'chunks', streamName);
        await fs.mkdir(chunksDir, { recursive: true });

        const writeChunk = (fileName: string, text: string, eof = false) =>
          fs.writeFile(
            path.join(chunksDir, fileName),
            serializeChunk({ chunk: Buffer.from(text), eof })
          );

        await Promise.all([
          writeChunk(`chnk_01.json`, 'legacy-shadowed'),
          writeChunk(`chnk_01.bin`, 'untagged-shadowed'),
          writeChunk(`chnk_01.vitest-0.bin`, 'tagged'),
          writeChunk(`chnk_02.json`, 'legacy-shadowed'),
          writeChunk(`chnk_02.bin`, 'untagged'),
          writeChunk(`chnk_03.json`, 'legacy'),
          writeChunk(`chnk_04.vitest-0.bin`, '', true),
        ]);

        const result = await taggedStreamer.streams.getChunks(
          TEST_RUN_ID,
          streamName
        );

        expect(
          result.data.map((chunk) => Buffer.from(chunk.data).toString())
        ).toEqual(['tagged', 'untagged', 'legacy']);
        expect(result.done).toBe(true);
      });

      it('should return done=false for in-progress stream', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'in-progress';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'data');

        const result = await streamer.streams.getChunks(
          TEST_RUN_ID,
          streamName
        );
        expect(result.data).toHaveLength(1);
        expect(result.done).toBe(false);
      });

      it('should return empty data for nonexistent stream', async () => {
        const { streamer } = await setupStreamer();

        const result = await streamer.streams.getChunks(
          TEST_RUN_ID,
          'nonexistent'
        );
        expect(result.data).toEqual([]);
        expect(result.hasMore).toBe(false);
      });

      it('should handle invalid cursor gracefully', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'bad-cursor';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'data');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        // Invalid cursor should reset to beginning
        const result = await streamer.streams.getChunks(
          TEST_RUN_ID,
          streamName,
          {
            cursor: 'not-valid-base64-json',
          }
        );
        expect(result.data).toHaveLength(1);
        expect(result.data[0].index).toBe(0);
      });
    });

    describe('getInfo', () => {
      it('should return tailIndex and done for completed stream', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'info-completed';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'b');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const info = await streamer.streams.getInfo(TEST_RUN_ID, streamName);
        expect(info.tailIndex).toBe(1);
        expect(info.done).toBe(true);
      });

      it('should return tailIndex for in-progress stream', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'info-progress';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'a');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.streams.write(TEST_RUN_ID, streamName, 'b');

        const info = await streamer.streams.getInfo(TEST_RUN_ID, streamName);
        expect(info.tailIndex).toBe(1);
        expect(info.done).toBe(false);
      });

      it('should return -1 for nonexistent stream', async () => {
        const { streamer } = await setupStreamer();

        const info = await streamer.streams.getInfo(TEST_RUN_ID, 'nonexistent');
        expect(info.tailIndex).toBe(-1);
        expect(info.done).toBe(false);
      });

      it('should return 0 tailIndex for single-chunk stream', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'single-chunk';

        await streamer.streams.write(TEST_RUN_ID, streamName, 'only');
        await streamer.streams.close(TEST_RUN_ID, streamName);

        const info = await streamer.streams.getInfo(TEST_RUN_ID, streamName);
        expect(info.tailIndex).toBe(0);
        expect(info.done).toBe(true);
      });
    });

    describe('integration scenarios', () => {
      it('should handle runId as a promise and flush correctly when promise resolves', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'promise-runid-test';

        // Create a promise that we'll resolve later
        let resolveRunId: (value: string) => void = () => {};
        const runIdPromise = new Promise<string>((resolve) => {
          resolveRunId = resolve;
        });

        // Write chunks with the promise (before it's resolved)
        const writePromise1 = streamer.streams.write(
          runIdPromise,
          streamName,
          'chunk1\n'
        );
        const writePromise2 = streamer.streams.write(
          runIdPromise,
          streamName,
          'chunk2\n'
        );

        // Verify that writes are pending (not yet flushed)
        let writes1Complete = false;
        let writes2Complete = false;
        writePromise1.then(() => {
          writes1Complete = true;
        });
        writePromise2.then(() => {
          writes2Complete = true;
        });

        // Give a small delay to ensure writes are initiated but blocked
        await new Promise((resolve) => setTimeout(resolve, 10));

        // At this point, writes should be pending
        expect(writes1Complete).toBe(false);
        expect(writes2Complete).toBe(false);

        // Now resolve the runId promise
        resolveRunId(TEST_RUN_ID);

        // Wait for writes to complete
        await writePromise1;
        await writePromise2;

        expect(writes1Complete).toBe(true);
        expect(writes2Complete).toBe(true);

        // Close the stream with another promise
        let resolveCloseRunId: (value: string) => void = () => {};
        const closeRunIdPromise = new Promise<string>((resolve) => {
          resolveCloseRunId = resolve;
        });

        const closePromise = streamer.streams.close(
          closeRunIdPromise,
          streamName
        );

        // Resolve the close promise
        resolveCloseRunId(TEST_RUN_ID);
        await closePromise;

        // Now read and verify all chunks were written correctly
        const stream = await streamer.streams.get(TEST_RUN_ID, streamName);
        const reader = stream.getReader();
        const chunks: string[] = [];

        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            chunks.push(Buffer.from(result.value).toString());
          }
        }

        const content = chunks.join('');
        expect(content).toBe('chunk1\nchunk2\n');
      });
    });
  });
});
