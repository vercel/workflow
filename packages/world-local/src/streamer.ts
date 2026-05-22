import { EventEmitter } from 'node:events';
import path from 'node:path';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import {
  assertSafeEntityId,
  listFilesByExtension,
  readBuffer,
  readJSONWithFallback,
  taggedPath,
  write,
  writeJSON,
} from './fs.js';

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

/** Check only the EOF flag byte without copying chunk payload. */
export function isEofChunk(serialized: Buffer): boolean {
  return serialized[0] === 1;
}

export function deserializeChunk(serialized: Buffer) {
  const eof = serialized[0] === 1;
  // Create a copy instead of a view to prevent ArrayBuffer detachment
  const chunk = Buffer.from(serialized.subarray(1));
  return { eof, chunk };
}

/**
 * List chunk files for a stream, sorted chronologically (ULID order).
 * Returns both the sorted file names and a map of file → extension for
 * resolving the full path. Handles tagged and legacy (.json) formats.
 */
async function listChunkFilesForStream(
  chunksDir: string,
  name: string,
  tag?: string
): Promise<{ files: string[]; extMap: Map<string, string> }> {
  // Name is used as a filename prefix below; validate it can't escape chunksDir.
  assertSafeEntityId('streamName', name);
  const listPromises: Promise<string[]>[] = [
    listFilesByExtension(chunksDir, '.bin'),
    listFilesByExtension(chunksDir, '.json'),
  ];
  if (tag) {
    listPromises.push(listFilesByExtension(chunksDir, `.${tag}.bin`));
  }
  const [binFiles, jsonFiles, ...taggedResults] =
    await Promise.all(listPromises);
  const taggedBinFiles = taggedResults[0] ?? [];

  const extMap = new Map<string, string>();
  for (const f of jsonFiles) extMap.set(f, '.json');
  const tagSfx = tag ? `.${tag}` : '';
  for (const f of binFiles) {
    if (tag && f.endsWith(tagSfx)) continue;
    extMap.set(f, '.bin');
  }
  for (const f of taggedBinFiles) extMap.set(f, `.${tag}.bin`);

  const files = [...extMap.keys()]
    .filter((file) => file.startsWith(`${name}-`))
    .sort();

  return { files, extMap };
}

export function createStreamer(basedir: string, tag?: string): Streamer {
  const tagSuffix = tag ? `.${tag}` : '';
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
    assertSafeEntityId('runId', runId);
    assertSafeEntityId('streamName', streamName);
    const cacheKey = `${runId}:${streamName}`;
    if (registeredStreams.has(cacheKey)) {
      return; // Already registered in this session
    }

    const runStreamsPath = taggedPath(basedir, 'streams/runs', runId, tag);

    // Read existing streams for this run (try tagged first, fall back to untagged)
    const existing = await readJSONWithFallback(
      basedir,
      'streams/runs',
      runId,
      RunStreamsSchema,
      tag
    );
    const streams = existing?.streams ?? [];

    // Add stream if not already present
    if (!streams.includes(streamName)) {
      streams.push(streamName);
      await writeJSON(runStreamsPath, { streams }, { overwrite: true });
    }

    registeredStreams.add(cacheKey);
  }

  // Helper to convert a chunk to a Buffer
  function toBuffer(chunk: string | Uint8Array): Buffer {
    if (typeof chunk === 'string') {
      return Buffer.from(new TextEncoder().encode(chunk));
    } else if (chunk instanceof Buffer) {
      return chunk;
    } else {
      return Buffer.from(chunk);
    }
  }

  return {
    streams: {
      async write(
        _runId: string | Promise<string>,
        name: string,
        chunk: string | Uint8Array
      ) {
        // Generate ULID synchronously BEFORE any await to preserve call order.
        // This ensures that chunks written in sequence maintain their order even
        // when runId is a promise that multiple writes are waiting on.
        const chunkId = `chnk_${monotonicUlid()}`;

        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;

        // Register this stream for the run
        await registerStreamForRun(runId, name);

        // Convert chunk to buffer for serialization
        const chunkBuffer = toBuffer(chunk);

        const serialized = serializeChunk({
          chunk: chunkBuffer,
          eof: false,
        });

        const chunkPath = path.join(
          basedir,
          'streams',
          'chunks',
          `${name}-${chunkId}${tagSuffix}.bin`
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

      async writeMulti(
        _runId: string | Promise<string>,
        name: string,
        chunks: (string | Uint8Array)[]
      ) {
        if (chunks.length === 0) return;

        // Generate all ULIDs synchronously BEFORE any await to preserve call order.
        // This ensures that chunks maintain their order even when runId is a promise.
        const chunkIds = chunks.map(() => `chnk_${monotonicUlid()}`);

        // Await runId if it's a promise
        const runId = await _runId;

        // Register this stream for the run
        await registerStreamForRun(runId, name);

        // Prepare chunk data for parallel writes
        const chunkBuffers = chunks.map((chunk) => toBuffer(chunk));

        // Write all chunks in parallel for efficiency, but track individual completion
        const writePromises = chunkBuffers.map(async (chunkBuffer, i) => {
          const chunkId = chunkIds[i];

          const serialized = serializeChunk({
            chunk: chunkBuffer,
            eof: false,
          });

          const chunkPath = path.join(
            basedir,
            'streams',
            'chunks',
            `${name}-${chunkId}${tagSuffix}.bin`
          );

          await write(chunkPath, serialized);

          // Return data needed for event emission
          return {
            chunkId,
            chunkData: Uint8Array.from(chunkBuffer),
          };
        });

        // Emit events in order, waiting for each chunk's write to complete
        // This ensures events are emitted in order while writes happen in parallel
        for (const writePromise of writePromises) {
          const { chunkId, chunkData } = await writePromise;

          streamEmitter.emit(`chunk:${name}` as const, {
            streamName: name,
            chunkData,
            chunkId,
          });
        }
      },

      async close(_runId: string | Promise<string>, name: string) {
        // Generate ULID synchronously BEFORE any await to preserve call order.
        const chunkId = `chnk_${monotonicUlid()}`;

        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;

        // Register this stream for the run (in case write wasn't called)
        await registerStreamForRun(runId, name);
        const chunkPath = path.join(
          basedir,
          'streams',
          'chunks',
          `${name}-${chunkId}${tagSuffix}.bin`
        );

        await write(
          chunkPath,
          serializeChunk({ chunk: Buffer.from([]), eof: true })
        );

        streamEmitter.emit(`close:${name}` as const, { streamName: name });
      },

      async list(runId: string) {
        assertSafeEntityId('runId', runId);
        const data = await readJSONWithFallback(
          basedir,
          'streams/runs',
          runId,
          RunStreamsSchema,
          tag
        );
        return data?.streams ?? [];
      },

      async getChunks(
        _runId: string,
        name: string,
        options?: GetChunksOptions
      ): Promise<StreamChunksResponse> {
        const limit = options?.limit ?? 100;
        const chunksDir = path.join(basedir, 'streams', 'chunks');
        const { files: chunkFiles, extMap: fileExtMap } =
          await listChunkFilesForStream(chunksDir, name, tag);

        // Decode cursor
        let startIndex = 0;
        if (options?.cursor) {
          try {
            const decoded = JSON.parse(
              Buffer.from(options.cursor, 'base64').toString('utf-8')
            );
            startIndex = decoded.i;
          } catch {
            startIndex = 0;
          }
        }

        // Walk from startIndex, reading only the files we need.
        // Files before the cursor are skipped entirely.
        let streamDone = false;
        const resultChunks: { index: number; data: Uint8Array }[] = [];
        let dataIndex = 0; // running count of data (non-EOF) files seen

        for (const file of chunkFiles) {
          const ext = fileExtMap.get(file) ?? '.bin';
          const filePath = path.join(chunksDir, `${file}${ext}`);

          // Before the cursor: only need to check EOF (1 byte), skip content
          if (dataIndex < startIndex) {
            if (isEofChunk(await readBuffer(filePath))) {
              streamDone = true;
              break;
            }
            dataIndex++;
            continue;
          }

          // Collected enough data chunks — peek at the next file for EOF/hasMore
          if (resultChunks.length >= limit) {
            if (isEofChunk(await readBuffer(filePath))) {
              streamDone = true;
            } else {
              // More data files exist beyond this page
              dataIndex++;
            }
            break;
          }

          // In the page window: deserialize fully
          const chunk = deserializeChunk(await readBuffer(filePath));
          if (chunk.eof) {
            streamDone = true;
            break;
          }
          resultChunks.push({
            index: dataIndex,
            data: Uint8Array.from(chunk.chunk),
          });
          dataIndex++;
        }

        // hasMore = we know there are data files beyond this page
        const hasMore =
          !streamDone && dataIndex > startIndex + resultChunks.length;
        const nextIndex = startIndex + resultChunks.length;
        const nextCursor = hasMore
          ? Buffer.from(JSON.stringify({ i: nextIndex })).toString('base64')
          : null;

        return {
          data: resultChunks,
          cursor: nextCursor,
          hasMore,
          done: streamDone,
        };
      },

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        const chunksDir = path.join(basedir, 'streams', 'chunks');
        const { files: chunkFiles, extMap: fileExtMap } =
          await listChunkFilesForStream(chunksDir, name, tag);

        // Only read the first byte of each file to check EOF — no full
        // deserialization needed since we just need a count.
        let streamDone = false;
        let dataCount = 0;
        for (const file of chunkFiles) {
          const ext = fileExtMap.get(file) ?? '.bin';
          if (
            isEofChunk(await readBuffer(path.join(chunksDir, `${file}${ext}`)))
          ) {
            streamDone = true;
            break;
          }
          dataCount++;
        }

        return { tailIndex: dataCount - 1, done: streamDone };
      },

      async get(_runId: string, name: string, startIndex = 0) {
        const chunksDir = path.join(basedir, 'streams', 'chunks');
        let removeListeners = () => {};
        let pollInterval: ReturnType<typeof setInterval> | null = null;

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
            // Set when the controller is closed; guards against enqueue-after-close
            // in the polling callback when closeListener fires mid-iteration.
            let streamClosed = false;

            const chunkListener = (event: {
              streamName: string;
              chunkData: Uint8Array;
              chunkId: string;
            }) => {
              // Skip empty chunks to maintain consistency with disk reading behavior
              if (event.chunkData.byteLength === 0) {
                deliveredChunkIds.add(event.chunkId);
                return;
              }

              if (isReadingFromDisk) {
                deliveredChunkIds.add(event.chunkId);
                // Buffer chunks that arrive during disk reading to maintain order
                // Create a copy to prevent ArrayBuffer detachment when enqueued later
                bufferedEventChunks.push({
                  chunkId: event.chunkId,
                  chunkData: Uint8Array.from(event.chunkData),
                });
              } else if (!deliveredChunkIds.has(event.chunkId)) {
                // Guard against duplicates: polling may have already claimed this
                // chunk between its has() check and readBuffer() yield.
                deliveredChunkIds.add(event.chunkId);
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
              streamClosed = true;
              streamEmitter.off(`chunk:${name}` as const, chunkListener);
              streamEmitter.off(`close:${name}` as const, closeListener);
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
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

            // Now load existing chunks from disk.
            const { files: chunkFiles, extMap: fileExtMap } =
              await listChunkFilesForStream(chunksDir, name, tag);

            // Resolve negative startIndex relative to the number of data chunks
            // (excluding the trailing EOF marker chunk, if present).
            let dataChunkCount = chunkFiles.length;
            if (
              typeof startIndex === 'number' &&
              startIndex < 0 &&
              chunkFiles.length > 0
            ) {
              const lastFile = chunkFiles[chunkFiles.length - 1];
              const lastExt = fileExtMap.get(lastFile) ?? '.bin';
              // Note: this incurs an extra disk read to check the EOF marker.
              // Acceptable since negative startIndex is not a hot path.
              const lastChunk = deserializeChunk(
                await readBuffer(path.join(chunksDir, `${lastFile}${lastExt}`))
              );
              if (lastChunk?.eof === true) {
                dataChunkCount--;
              }
            }
            const resolvedStartIndex =
              typeof startIndex === 'number' && startIndex < 0
                ? Math.max(0, dataChunkCount + startIndex)
                : startIndex;

            // Process existing chunks, skipping any already delivered via events
            let isComplete = false;
            for (let i = resolvedStartIndex; i < chunkFiles.length; i++) {
              const file = chunkFiles[i];
              // Extract chunk ID from filename: "streamName-chunkId" or "streamName-chunkId.tag"
              const rawChunkId = file.substring(name.length + 1);
              // Strip tag suffix (e.g., "chnk_ULID.vitest-0" → "chnk_ULID")
              const chunkId = tag
                ? rawChunkId.replace(`.${tag}`, '')
                : rawChunkId;

              // Skip if already delivered via event
              if (deliveredChunkIds.has(chunkId)) {
                continue;
              }

              const ext = fileExtMap.get(file) ?? '.bin';
              const chunk = deserializeChunk(
                await readBuffer(path.join(chunksDir, `${file}${ext}`))
              );
              if (chunk?.eof === true) {
                isComplete = true;
                break;
              }
              // Track as handled so polling doesn't re-deliver
              deliveredChunkIds.add(chunkId);
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
              return;
            }

            // Track pre-startIndex chunks so polling doesn't re-deliver them
            for (
              let i = 0;
              i < resolvedStartIndex && i < chunkFiles.length;
              i++
            ) {
              const file = chunkFiles[i];
              const rawChunkId = file.substring(name.length + 1);
              const chunkId = tag
                ? rawChunkId.replace(`.${tag}`, '')
                : rawChunkId;
              deliveredChunkIds.add(chunkId);
            }

            // Start filesystem polling for cross-process streaming support.
            // The EventEmitter only works in-process; when the writer is in a
            // separate process (e.g. e2e test runner ↔ workbench app), polling
            // the shared filesystem is the fallback delivery mechanism.
            let isPolling = false;
            pollInterval = setInterval(async () => {
              if (isPolling) return;
              isPolling = true;
              try {
                const { files: currentFiles, extMap: currentExtMap } =
                  await listChunkFilesForStream(chunksDir, name, tag);

                for (const file of currentFiles) {
                  const rawChunkId = file.substring(name.length + 1);
                  const chunkId = tag
                    ? rawChunkId.replace(`.${tag}`, '')
                    : rawChunkId;

                  if (deliveredChunkIds.has(chunkId)) continue;
                  deliveredChunkIds.add(chunkId);

                  const ext = currentExtMap.get(file) ?? '.bin';
                  const chunk = deserializeChunk(
                    await readBuffer(path.join(chunksDir, `${file}${ext}`))
                  );

                  if (chunk?.eof === true) {
                    streamClosed = true;
                    if (pollInterval) {
                      clearInterval(pollInterval);
                      pollInterval = null;
                    }
                    streamEmitter.off(`chunk:${name}` as const, chunkListener);
                    streamEmitter.off(`close:${name}` as const, closeListener);
                    try {
                      controller.close();
                    } catch {
                      // Ignore if controller is already closed
                    }
                    return;
                  }

                  // Guard against enqueue-after-close: closeListener may have
                  // fired between our readBuffer() yield and this point.
                  if (streamClosed) return;

                  if (chunk.chunk.byteLength) {
                    controller.enqueue(Uint8Array.from(chunk.chunk));
                  }
                }
              } catch (err: unknown) {
                // Silently ignore transient filesystem errors (ENOENT, EACCES, etc.)
                // Surface unexpected errors so bugs aren't hidden
                if (!(err instanceof Error && 'code' in err)) {
                  console.error('[world-local] Unexpected polling error:', err);
                }
              } finally {
                isPolling = false;
              }
            }, 100);
          },

          cancel() {
            removeListeners();
            if (pollInterval) {
              clearInterval(pollInterval);
              pollInterval = null;
            }
          },
        });
      },
    },
  };
}
