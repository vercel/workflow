import { promises as fs } from 'node:fs';
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
    async function setupStreamer() {
      const testDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'streamer-test-')
      );
      const streamer = createStreamer(testDir);

      onTestFinished(async (ctx) => {
        if (!ctx.task.result?.errors?.length) {
          await fs.rm(testDir, { recursive: true, force: true });
        } else {
          const files = await fs.readdir(`${testDir}/streams/chunks`);
          const chunks = [] as unknown[];
          let lastTime = 0;
          for (const file of files) {
            const chunk = deserializeChunk(
              await fs.readFile(`${testDir}/streams/chunks/${file}`)
            );
            const stream_id = String(file.split('-').at(-1)).split('.')[0];
            const time = decodeTime(stream_id);
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
      });

      return {
        testDir,
        streamer,
      };
    }

    describe('writeToStream', () => {
      it('should write string chunks to a stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'test-stream';

        await streamer.writeToStream(streamName, TEST_RUN_ID, 'hello');
        await streamer.writeToStream(streamName, TEST_RUN_ID, ' world');

        // Verify chunks directory was created
        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(2);
        expect(files.every((f) => f.startsWith(`${streamName}-`))).toBe(true);
        expect(files.every((f) => f.endsWith('.json'))).toBe(true);
      });

      it('should write Buffer chunks to a stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'buffer-stream';
        const buffer1 = Buffer.from('chunk1');
        const buffer2 = Buffer.from('chunk2');

        await streamer.writeToStream(streamName, TEST_RUN_ID, buffer1);
        await streamer.writeToStream(streamName, TEST_RUN_ID, buffer2);

        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(2);
        expect(files.every((f) => f.startsWith(`${streamName}-`))).toBe(true);
      });

      it('should write Uint8Array chunks to a stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'uint8-stream';
        const uint8Array = new Uint8Array([1, 2, 3, 4]);

        await streamer.writeToStream(streamName, TEST_RUN_ID, uint8Array);

        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(`${streamName}-`);
      });

      it('should handle multiple streams independently', async () => {
        const { testDir, streamer } = await setupStreamer();

        await streamer.writeToStream('stream1', TEST_RUN_ID, 'data1');
        await streamer.writeToStream('stream2', TEST_RUN_ID, 'data2');
        await streamer.writeToStream('stream1', TEST_RUN_ID, 'data3');

        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const files = await fs.readdir(chunksDir);

        const stream1Files = files.filter((f) => f.startsWith('stream1-'));
        const stream2Files = files.filter((f) => f.startsWith('stream2-'));

        expect(stream1Files).toHaveLength(2);
        expect(stream2Files).toHaveLength(1);
      });
    });

    describe('closeStream', () => {
      it('should close an empty stream', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'empty-stream';

        await streamer.closeStream(streamName, TEST_RUN_ID);

        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(`${streamName}-`);
      });

      it('should close a stream with existing chunks', async () => {
        const { testDir, streamer } = await setupStreamer();
        const streamName = 'existing-stream';

        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk1');
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk2');
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const chunksDir = path.join(testDir, 'streams', 'chunks');
        const files = await fs.readdir(chunksDir);

        expect(files).toHaveLength(3); // 2 data chunks + 1 EOF chunk
      });
    });

    describe('readFromStream', () => {
      it('should read chunks from a completed stream', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'read-stream';
        const chunk1 = 'hello ';
        const chunk2 = 'world';

        await streamer.writeToStream(streamName, TEST_RUN_ID, chunk1);
        // Add a small delay to ensure different ULID timestamps
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, chunk2);
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const stream = await streamer.readFromStream(streamName);
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

        await streamer.writeToStream(streamName, TEST_RUN_ID, binaryData1);
        // Add delay to ensure different ULID timestamps
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, binaryData2);
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const stream = await streamer.readFromStream(streamName);
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
        await streamer.writeToStream(streamName, TEST_RUN_ID, '1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, '2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, '3');
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const stream = await streamer.readFromStream(streamName);
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
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk0');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk3');

        // First read: Simulate initial connection that gets interrupted after 2 chunks
        // Note: Stream is NOT closed yet - simulates reading while workflow is still running
        const stream1 = await streamer.readFromStream(streamName, 0);
        const reader1 = stream1.getReader();

        // Read first 2 chunks
        const result1 = await reader1.read();
        const result2 = await reader1.read();
        expect(Buffer.from(result1.value!).toString()).toBe('chunk0');
        expect(Buffer.from(result2.value!).toString()).toBe('chunk1');

        // Cancel the first stream (simulating connection loss / timeout)
        await reader1.cancel();

        // Workflow continues and finishes
        await streamer.closeStream(streamName, TEST_RUN_ID);

        // Second read: Resume from startIndex=2 (this is where ArrayBuffer detachment bug occurs)
        // Without the fix, this would fail with "Cannot perform Construct on a detached ArrayBuffer"
        const stream2 = await streamer.readFromStream(streamName, 2);
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
    });

    describe('integration scenarios', () => {
      it('should handle complete write-close-read cycle', async () => {
        const { streamer } = await setupStreamer();
        const streamName = 'integration-stream';

        // Write chunks with proper timing
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'start ');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'middle ');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'end');

        // Close the stream
        await streamer.closeStream(streamName, TEST_RUN_ID);

        // Read complete stream
        const completeStream = await streamer.readFromStream(streamName);
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
        // Run multiple iterations to increase probability of catching race conditions
        for (let iteration = 0; iteration < 10; iteration++) {
          const { streamer } = await setupStreamer();
          const streamName = `race-${iteration}`;

          // Write a few chunks to disk first
          await streamer.writeToStream(streamName, TEST_RUN_ID, '0\n');
          await streamer.writeToStream(streamName, TEST_RUN_ID, '1\n');

          // Start writing chunks in background IMMEDIATELY before reading
          const writeTask = (async () => {
            for (let i = 2; i < 10; i++) {
              await streamer.writeToStream(streamName, TEST_RUN_ID, `${i}\n`);
              // No delay - fire them off as fast as possible to hit the race window
            }
            await streamer.closeStream(streamName, TEST_RUN_ID);
          })();

          // Start reading - this triggers start() which should set up listeners
          // BEFORE listing files to avoid missing chunks, and track delivered
          // chunk IDs to avoid duplicates
          const stream = await streamer.readFromStream(streamName);
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
          await streamer.writeToStream(streamName, TEST_RUN_ID, `${i}\n`);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }

        // Start reading
        const stream = await streamer.readFromStream(streamName);
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
          await streamer.writeToStream(streamName, TEST_RUN_ID, `${i}\n`);
        }

        await streamer.closeStream(streamName, TEST_RUN_ID);
        await readPromise;

        // Verify chunks are in exact chronological order (not just all present)
        const content = chunks.join('');
        expect(content).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
      });
    });

    describe('listStreamsByRunId', () => {
      it('should return empty array when no streams exist', async () => {
        const { streamer } = await setupStreamer();

        const streams = await streamer.listStreamsByRunId(TEST_RUN_ID);
        expect(streams).toEqual([]);
      });

      it('should return streams associated with the runId', async () => {
        const { streamer } = await setupStreamer();

        // Stream names can be anything - they're tracked via explicit mapping
        const streamName1 = 'my-stdout-stream';
        const streamName2 = 'my-stderr-stream';

        await streamer.writeToStream(streamName1, TEST_RUN_ID, 'stdout output');
        await streamer.writeToStream(streamName2, TEST_RUN_ID, 'stderr output');
        await streamer.closeStream(streamName1, TEST_RUN_ID);
        await streamer.closeStream(streamName2, TEST_RUN_ID);

        const streams = await streamer.listStreamsByRunId(TEST_RUN_ID);

        expect(streams).toHaveLength(2);
        expect(streams).toContain(streamName1);
        expect(streams).toContain(streamName2);
      });

      it('should not return streams from different runIds', async () => {
        const { streamer } = await setupStreamer();

        const otherRunId = 'wrun_other1234567890123';

        const targetStream = 'target-stdout';
        const otherStream = 'other-stdout';

        await streamer.writeToStream(
          targetStream,
          TEST_RUN_ID,
          'target output'
        );
        await streamer.writeToStream(otherStream, otherRunId, 'other output');

        const streams = await streamer.listStreamsByRunId(TEST_RUN_ID);

        expect(streams).toHaveLength(1);
        expect(streams).toContain(targetStream);
        expect(streams).not.toContain(otherStream);

        // Also verify the other run has only its stream
        const otherStreams = await streamer.listStreamsByRunId(otherRunId);
        expect(otherStreams).toHaveLength(1);
        expect(otherStreams).toContain(otherStream);
      });

      it('should return unique stream names even with multiple chunks', async () => {
        const { streamer } = await setupStreamer();

        const streamName = 'chunked-output';

        // Write multiple chunks to the same stream
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk1');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk2');
        await new Promise((resolve) => setTimeout(resolve, 2));
        await streamer.writeToStream(streamName, TEST_RUN_ID, 'chunk3');
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const streams = await streamer.listStreamsByRunId(TEST_RUN_ID);

        // Should only return the stream name once, not once per chunk
        expect(streams).toHaveLength(1);
        expect(streams).toContain(streamName);
      });

      it('should handle stream names with dashes', async () => {
        const { streamer } = await setupStreamer();

        const streamName = 'my-complex-stream-name';

        await streamer.writeToStream(streamName, TEST_RUN_ID, 'data');
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const streams = await streamer.listStreamsByRunId(TEST_RUN_ID);

        expect(streams).toHaveLength(1);
        expect(streams).toContain(streamName);
      });

      it('should register stream even if only closeStream is called', async () => {
        const { streamer } = await setupStreamer();

        const streamName = 'close-only-stream';

        // Only call closeStream without writeToStream
        await streamer.closeStream(streamName, TEST_RUN_ID);

        const streams = await streamer.listStreamsByRunId(TEST_RUN_ID);

        expect(streams).toHaveLength(1);
        expect(streams).toContain(streamName);
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
        const writePromise1 = streamer.writeToStream(
          streamName,
          runIdPromise,
          'chunk1\n'
        );
        const writePromise2 = streamer.writeToStream(
          streamName,
          runIdPromise,
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

        const closePromise = streamer.closeStream(
          streamName,
          closeRunIdPromise
        );

        // Resolve the close promise
        resolveCloseRunId(TEST_RUN_ID);
        await closePromise;

        // Now read and verify all chunks were written correctly
        const stream = await streamer.readFromStream(streamName);
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
