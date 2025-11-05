import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { listJSONFiles, readBuffer, write } from './fs.js';

// Create a monotonic ULID factory that ensures ULIDs are always increasing
// even when generated within the same millisecond
const monotonicUlid = monotonicFactory(() => Math.random());

/**
 * A chunk consists of a boolean `eof` indicating if it's the last chunk,
 * and a `chunk` which is a Buffer of data.
 * The serialized format is:
 * - 1 byte for `eof` (0 or 1)
 * - and the rest is the chunk data.
 */
export interface Chunk {
  eof: boolean;
  chunk: Buffer;
}

export function serializeChunk(chunk: Chunk) {
  const eofByte = Buffer.from([chunk.eof ? 1 : 0]);
  return Buffer.concat([eofByte, chunk.chunk]);
}

export function deserializeChunk(serialized: Buffer) {
  const eof = serialized[0] === 1;
  const chunk = serialized.subarray(1);
  return { eof, chunk };
}

export function createStreamer(basedir: string): Streamer {
  const streamEmitter = new EventEmitter<{
    [key: `chunk:${string}`]: [
      {
        streamName: string;
        chunkData: Uint8Array;
        chunkId: string;
      },
    ];
    [key: `close:${string}`]: [
      {
        streamName: string;
      },
    ];
  }>();

  return {
    async writeToStream(
      _runId: string,
      name: string,
      chunk: string | Uint8Array
    ) {
      const chunkId = `strm_${monotonicUlid()}`;

      if (typeof chunk === 'string') {
        chunk = new TextEncoder().encode(chunk);
      }
      const serialized = serializeChunk({
        chunk: Buffer.from(chunk),
        eof: false,
      });

      const chunkPath = path.join(
        basedir,
        'streams',
        'chunks',
        `${name}-${chunkId}.json`
      );

      await write(chunkPath, serialized);

      // Emit real-time event
      const chunkData =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : chunk instanceof Buffer
            ? new Uint8Array(chunk)
            : chunk;

      streamEmitter.emit(`chunk:${name}` as const, {
        streamName: name,
        chunkData,
        chunkId,
      });
    },

    async closeStream(_runId: string, name: string) {
      const chunkId = `strm_${monotonicUlid()}`;
      const chunkPath = path.join(
        basedir,
        'streams',
        'chunks',
        `${name}-${chunkId}.json`
      );

      await write(
        chunkPath,
        serializeChunk({ chunk: Buffer.from([]), eof: true })
      );

      streamEmitter.emit(`close:${name}` as const, { streamName: name });
    },

    async readFromStream(_runId: string, name: string, startIndex = 0) {
      const chunksDir = path.join(basedir, 'streams', 'chunks');
      let removeListeners = () => {};

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Track chunks delivered via events to prevent duplicates and maintain order.
          const deliveredChunkIds = new Set<string>();
          // Buffer for chunks that arrive via events during disk reading
          const bufferedEventChunks: Array<{
            chunkId: string;
            chunkData: Uint8Array;
          }> = [];
          let isReadingFromDisk = true;

          const chunkListener = (event: {
            streamName: string;
            chunkData: Uint8Array;
            chunkId: string;
          }) => {
            deliveredChunkIds.add(event.chunkId);

            if (isReadingFromDisk) {
              // Buffer chunks that arrive during disk reading to maintain order
              bufferedEventChunks.push({
                chunkId: event.chunkId,
                chunkData: event.chunkData,
              });
            } else {
              // After disk reading is complete, deliver chunks immediately
              controller.enqueue(event.chunkData);
            }
          };

          const closeListener = () => {
            // Remove listeners before closing
            streamEmitter.off(`chunk:${name}` as const, chunkListener);
            streamEmitter.off(`close:${name}` as const, closeListener);
            controller.close();
          };
          removeListeners = closeListener;

          // Set up listeners FIRST to avoid missing events
          streamEmitter.on(`chunk:${name}` as const, chunkListener);
          streamEmitter.on(`close:${name}` as const, closeListener);

          // Now load existing chunks from disk
          const files = await listJSONFiles(chunksDir);
          const chunkFiles = files
            .filter((file) => file.startsWith(`${name}-`))
            .sort(); // ULID lexicographic sort = chronological order

          // Process existing chunks, skipping any already delivered via events
          let isComplete = false;
          for (let i = startIndex; i < chunkFiles.length; i++) {
            const file = chunkFiles[i];
            // Extract chunk ID from filename: "streamName-chunkId"
            const chunkId = file.substring(name.length + 1);

            // Skip if already delivered via event
            if (deliveredChunkIds.has(chunkId)) {
              continue;
            }

            const chunk = deserializeChunk(
              await readBuffer(path.join(chunksDir, `${file}.json`))
            );
            if (chunk?.eof === true) {
              isComplete = true;
              break;
            }
            if (chunk.chunk.byteLength) {
              controller.enqueue(chunk.chunk);
            }
          }

          // Finished reading from disk - now deliver buffered event chunks in chronological order
          isReadingFromDisk = false;

          // Sort buffered chunks by ULID (chronological order)
          bufferedEventChunks.sort((a, b) =>
            a.chunkId.localeCompare(b.chunkId)
          );
          for (const buffered of bufferedEventChunks) {
            controller.enqueue(buffered.chunkData);
          }

          if (isComplete) {
            removeListeners();
            controller.close();
            return;
          }
        },

        cancel() {
          removeListeners();
        },
      });
    },
  };
}
