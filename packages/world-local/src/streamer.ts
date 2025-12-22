import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { listJSONFiles, readBuffer, readJSON, write, writeJSON } from './fs.js';

// Create a monotonic ULID factory that ensures ULIDs are always increasing
// even when generated within the same millisecond
const monotonicUlid = monotonicFactory(() => Math.random());

// Schema for the run-to-streams mapping file
const RunStreamsSchema = z.object({
  streams: z.array(z.string()),
});

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
  // Create a copy instead of a view to prevent ArrayBuffer detachment
  const chunk = Buffer.from(serialized.subarray(1));
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

  // Track which streams have already been registered for a run (in-memory cache)
  const registeredStreams = new Set<string>();

  // Helper to record the runId <> streamId association
  async function registerStreamForRun(
    runId: string,
    streamName: string
  ): Promise<void> {
    const cacheKey = `${runId}:${streamName}`;
    if (registeredStreams.has(cacheKey)) {
      return; // Already registered in this session
    }

    const runStreamsPath = path.join(
      basedir,
      'streams',
      'runs',
      `${runId}.json`
    );

    // Read existing streams for this run
    const existing = await readJSON(runStreamsPath, RunStreamsSchema);
    const streams = existing?.streams ?? [];

    // Add stream if not already present
    if (!streams.includes(streamName)) {
      streams.push(streamName);
      await writeJSON(runStreamsPath, { streams }, { overwrite: true });
    }

    registeredStreams.add(cacheKey);
  }

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      // Register this stream for the run
      await registerStreamForRun(runId, name);

      const chunkId = `chnk_${monotonicUlid()}`;

      // Convert chunk to buffer for serialization
      let chunkBuffer: Buffer;
      if (typeof chunk === 'string') {
        chunkBuffer = Buffer.from(new TextEncoder().encode(chunk));
      } else if (chunk instanceof Buffer) {
        chunkBuffer = chunk;
      } else {
        chunkBuffer = Buffer.from(chunk);
      }

      const serialized = serializeChunk({
        chunk: chunkBuffer,
        eof: false,
      });

      const chunkPath = path.join(
        basedir,
        'streams',
        'chunks',
        `${name}-${chunkId}.json`
      );

      await write(chunkPath, serialized);

      // Emit real-time event with Uint8Array (create copy to prevent ArrayBuffer detachment)
      const chunkData = Uint8Array.from(chunkBuffer);

      streamEmitter.emit(`chunk:${name}` as const, {
        streamName: name,
        chunkData,
        chunkId,
      });
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      // Register this stream for the run (in case writeToStream wasn't called)
      await registerStreamForRun(runId, name);

      const chunkId = `chnk_${monotonicUlid()}`;
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

    async listStreamsByRunId(runId: string) {
      const runStreamsPath = path.join(
        basedir,
        'streams',
        'runs',
        `${runId}.json`
      );

      const data = await readJSON(runStreamsPath, RunStreamsSchema);
      return data?.streams ?? [];
    },

    async readFromStream(name: string, startIndex = 0) {
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
          // Buffer close event if it arrives during disk reading
          let pendingClose = false;

          const chunkListener = (event: {
            streamName: string;
            chunkData: Uint8Array;
            chunkId: string;
          }) => {
            deliveredChunkIds.add(event.chunkId);

            // Skip empty chunks to maintain consistency with disk reading behavior
            // Empty chunks are not enqueued when read from disk (see line 184-186)
            if (event.chunkData.byteLength === 0) {
              return;
            }

            if (isReadingFromDisk) {
              // Buffer chunks that arrive during disk reading to maintain order
              // Create a copy to prevent ArrayBuffer detachment when enqueued later
              bufferedEventChunks.push({
                chunkId: event.chunkId,
                chunkData: Uint8Array.from(event.chunkData),
              });
            } else {
              // After disk reading is complete, deliver chunks immediately
              // Create a copy to prevent ArrayBuffer detachment
              controller.enqueue(Uint8Array.from(event.chunkData));
            }
          };

          const closeListener = () => {
            // Buffer close event if disk reading is still in progress
            if (isReadingFromDisk) {
              pendingClose = true;
              return;
            }
            // Remove listeners before closing
            streamEmitter.off(`chunk:${name}` as const, chunkListener);
            streamEmitter.off(`close:${name}` as const, closeListener);
            try {
              controller.close();
            } catch {
              // Ignore if controller is already closed (e.g., from cancel() or EOF)
            }
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
              // Create a copy to prevent ArrayBuffer detachment
              controller.enqueue(Uint8Array.from(chunk.chunk));
            }
          }

          // Finished reading from disk - now deliver buffered event chunks in chronological order
          isReadingFromDisk = false;

          // Sort buffered chunks by ULID (chronological order)
          bufferedEventChunks.sort((a, b) =>
            a.chunkId.localeCompare(b.chunkId)
          );
          for (const buffered of bufferedEventChunks) {
            // Create a copy for defense in depth (already copied at storage, but be extra safe)
            controller.enqueue(Uint8Array.from(buffered.chunkData));
          }

          if (isComplete) {
            removeListeners();
            try {
              controller.close();
            } catch {
              // Ignore if controller is already closed (e.g., from closeListener event)
            }
            return;
          }

          // Process any pending close event that arrived during disk reading
          if (pendingClose) {
            streamEmitter.off(`chunk:${name}` as const, chunkListener);
            streamEmitter.off(`close:${name}` as const, closeListener);
            try {
              controller.close();
            } catch {
              // Ignore if controller is already closed
            }
          }
        },

        cancel() {
          removeListeners();
        },
      });
    },
  };
}
