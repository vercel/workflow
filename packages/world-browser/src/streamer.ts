/**
 * Streamer implementation for browser using SQLite and Web Streams API.
 */

import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { BrowserDatabase } from './schema.js';

const ulid = monotonicFactory();

// Stream chunk row type
interface StreamChunkRow {
  chunk_id: string;
  stream_id: string;
  chunk_data: Uint8Array;
  eof: number;
  created_at: string;
}

// Event emitter for stream updates (simple implementation)
type StreamListener = (chunk: {
  id: string;
  data: Uint8Array;
  eof: boolean;
}) => void;
const streamListeners = new Map<string, Set<StreamListener>>();

function emitStreamChunk(
  streamId: string,
  chunk: { id: string; data: Uint8Array; eof: boolean }
) {
  const listeners = streamListeners.get(streamId);
  if (listeners) {
    for (const listener of listeners) {
      listener(chunk);
    }
  }
}

function addStreamListener(
  streamId: string,
  listener: StreamListener
): () => void {
  if (!streamListeners.has(streamId)) {
    streamListeners.set(streamId, new Set());
  }
  streamListeners.get(streamId)!.add(listener);
  return () => {
    streamListeners.get(streamId)?.delete(listener);
    if (streamListeners.get(streamId)?.size === 0) {
      streamListeners.delete(streamId);
    }
  };
}

/**
 * Create a Streamer implementation using SQLite for chunk storage.
 */
export function createStreamer(db: BrowserDatabase): Streamer {
  const genChunkId = () => `chnk_${ulid()}` as const;

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ): Promise<void> {
      // Await runId if it's a promise
      await _runId;

      const chunkId = genChunkId();
      const chunkData =
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;

      await db
        .prepare(`
        INSERT INTO workflow_stream_chunks (chunk_id, stream_id, chunk_data, eof, created_at)
        VALUES (?, ?, ?, 0, datetime('now'))
      `)
        .run([chunkId, name, chunkData]);

      // Emit to listeners
      emitStreamChunk(name, { id: chunkId, data: chunkData, eof: false });
    },

    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      // Await runId if it's a promise
      await _runId;

      const chunkId = genChunkId();

      await db
        .prepare(`
        INSERT INTO workflow_stream_chunks (chunk_id, stream_id, chunk_data, eof, created_at)
        VALUES (?, ?, ?, 1, datetime('now'))
      `)
        .run([chunkId, name, new Uint8Array(0)]);

      // Emit EOF to listeners
      emitStreamChunk(name, {
        id: chunkId,
        data: new Uint8Array(0),
        eof: true,
      });
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let lastChunkId = '';
          let offset = startIndex ?? 0;
          let buffer: Array<{
            id: string;
            data: Uint8Array;
            eof: boolean;
          }> | null = [];

          function enqueue(chunk: {
            id: string;
            data: Uint8Array;
            eof: boolean;
          }) {
            // Skip if already processed or out of order
            if (lastChunkId >= chunk.id) {
              return;
            }

            // Handle offset
            if (offset > 0) {
              offset--;
              return;
            }

            if (chunk.data.byteLength > 0) {
              controller.enqueue(new Uint8Array(chunk.data));
            }

            if (chunk.eof) {
              controller.close();
            }

            lastChunkId = chunk.id;
          }

          // Subscribe to new chunks
          const removeListener = addStreamListener(name, (chunk) => {
            if (buffer) {
              buffer.push(chunk);
              return;
            }
            enqueue(chunk);
          });

          // Load existing chunks
          const rows = await db
            .prepare(`
            SELECT chunk_id, stream_id, chunk_data, eof
            FROM workflow_stream_chunks
            WHERE stream_id = ?
            ORDER BY chunk_id ASC
          `)
            .all<StreamChunkRow>([name]);

          // Process existing chunks and buffered chunks
          const existingChunks = rows.map((row) => ({
            id: row.chunk_id,
            data: row.chunk_data,
            eof: row.eof === 1,
          }));

          for (const chunk of [...existingChunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }

          buffer = null;

          // Store cleanup function for cancel
          (controller as any)._cleanup = removeListener;
        },

        cancel(controller) {
          const cleanup = (controller as any)?._cleanup;
          if (typeof cleanup === 'function') {
            cleanup();
          }
        },
      });
    },
  };
}
