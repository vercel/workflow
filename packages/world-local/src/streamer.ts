import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { type LockOptions, lock } from 'proper-lockfile';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import {
  assertSafeEntityId,
  readBuffer,
  readFirstByte,
  readJSONWithFallback,
  taggedPath,
  write,
  writeJSON,
} from './fs.js';
import { withInProcessLock } from './util.js';

// Create a monotonic ULID factory that ensures ULIDs are always increasing
// even when generated within the same millisecond
const monotonicUlid = monotonicFactory(() => Math.random());

// Schema for the run-to-streams mapping file
const RunStreamsSchema = z.object({
  streams: z.array(z.string()),
});

/**
 * Lock options for updating a run's stream index
 * (`streams/runs/<runId>.json`) across processes. The critical section is
 * one small read and one write, so a holder either finishes within
 * milliseconds or has crashed: `stale` lets the next writer take over a lock
 * a crashed holder left behind, and the retries outlast `stale`.
 */
const RUN_STREAMS_LOCK_OPTIONS: LockOptions = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 150, factor: 1, minTimeout: 100, maxTimeout: 100 },
};

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

const EOF_MARKER = 1;

function isEofByte(byte: number | undefined): boolean {
  return byte === EOF_MARKER;
}

export function serializeChunk(chunk: Chunk) {
  const eofByte = Buffer.from([chunk.eof ? EOF_MARKER : 0]);
  return Buffer.concat([eofByte, chunk.chunk]);
}

/** Check only the EOF flag byte without copying chunk payload. */
export function isEofChunk(serialized: Buffer): boolean {
  return isEofByte(serialized[0]);
}

export function deserializeChunk(serialized: Buffer) {
  const eof = isEofChunk(serialized);
  // Create a copy instead of a view to prevent ArrayBuffer detachment
  const chunk = Buffer.from(serialized.subarray(1));
  return { eof, chunk };
}

async function listChunkEntries(chunksDir: string): Promise<string[]> {
  try {
    return await fs.readdir(chunksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function addChunkFilesByExtension(
  extMap: Map<string, string>,
  entries: string[],
  sourceExtension: string,
  fileExtension = sourceExtension,
  include: (file: string) => boolean = () => true
): void {
  for (const entry of entries) {
    if (!entry.endsWith(sourceExtension)) continue;
    const file = entry.slice(0, -sourceExtension.length);
    if (include(file)) extMap.set(file, fileExtension);
  }
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
  const entries = await listChunkEntries(chunksDir);
  const extMap = new Map<string, string>();
  addChunkFilesByExtension(extMap, entries, '.json');
  addChunkFilesByExtension(
    extMap,
    entries,
    '.bin',
    '.bin',
    tag ? (file) => !file.endsWith(`.${tag}`) : undefined
  );

  if (tag) {
    const taggedExtension = `.${tag}.bin`;
    addChunkFilesByExtension(extMap, entries, taggedExtension);
  }

  const files = [...extMap.keys()]
    .filter((file) => file.startsWith(`${name}-`))
    .sort();

  return { files, extMap };
}

export function createStreamer(
  basedir: string,
  tag?: string
): Streamer & {
  /**
   * Forget which streams this instance has registered. `clear()` calls it
   * after deleting the stream indexes, so a stream written again afterwards
   * is registered again.
   */
  clearCache(): void;
} {
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

  // Streams this instance has registered (`<runId>:<name>`), so only a
  // stream's first write touches the run's stream index.
  const registeredStreams = new Set<string>();
  // A reader delivers the chunk files it lists, so a chunk must not land
  // before one with a smaller id: writes to one stream run one at a time, in
  // the order they took their ids.
  const streamWriteLocks = new Map<string, Promise<unknown>>();
  // Serializes this instance's updates to one run's stream index. The file
  // lock in `addToRunStreams` does the same across instances and processes.
  const runStreamsLocks = new Map<string, Promise<unknown>>();
  let warnedRunStreamsLockFailure = false;

  async function readRunStreams(runId: string): Promise<string[]> {
    const data = await readJSONWithFallback(
      basedir,
      'streams/runs',
      runId,
      RunStreamsSchema,
      tag
    );
    return data?.streams ?? [];
  }

  /**
   * Record the run → stream association in the run's stream index,
   * `streams/runs/<runId>.json`, which `listStreamsByRunId()` reads.
   *
   * The index is one file per run, so adding a name is a read-modify-write:
   * two streams of one run that first write at the same time would each read
   * the old list, and the later rename would drop the earlier name. The
   * update therefore runs under a per-instance mutex, like the event writes
   * in events-storage, and a proper-lockfile lock across processes, like the
   * hook token claim. The file format is unchanged, so older readers (the
   * CLI, the web UI) read the index without a migration.
   *
   * `verify` re-reads the index even for a stream this instance already
   * registered, and registers it again if it is missing. `closeStream()` uses
   * it to put back a name dropped by a writer that does not take the lock,
   * such as an older world-local sharing the data directory.
   */
  async function registerStreamForRun(
    runId: string,
    streamName: string,
    { verify = false }: { verify?: boolean } = {}
  ): Promise<void> {
    assertSafeEntityId('runId', runId);
    assertSafeEntityId('streamName', streamName);
    const cacheKey = `${runId}:${streamName}`;
    if (registeredStreams.has(cacheKey)) {
      if (!verify) return;
      // The re-check is best effort: a failed read says nothing about the
      // name, and must not fail a close() that used to skip the index.
      const listed = await readRunStreams(runId).catch(() => null);
      if (listed === null || listed.includes(streamName)) return;
      registeredStreams.delete(cacheKey);
    }

    const runStreamsPath = taggedPath(basedir, 'streams/runs', runId, tag);
    await withInProcessLock(runStreamsLocks, runStreamsPath, async () => {
      // Another call in this instance may have registered the stream while
      // this one waited for the mutex.
      if (registeredStreams.has(cacheKey)) return;
      if (await addToRunStreams(runStreamsPath, runId, streamName)) {
        registeredStreams.add(cacheKey);
      }
    });
  }

  /**
   * Add `streamName` to the run's stream index while holding the index's file
   * lock. Resolves `false` when the lock was compromised during the update
   * (another writer judged it stale and took it over), so the caller does not
   * cache the stream and its next write checks the index again.
   */
  async function addToRunStreams(
    runStreamsPath: string,
    runId: string,
    streamName: string
  ): Promise<boolean> {
    // The lock is a directory next to the index, so its parent must exist.
    await fs.mkdir(path.dirname(runStreamsPath), { recursive: true });
    let compromised = false;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(runStreamsPath, {
        ...RUN_STREAMS_LOCK_OPTIONS,
        // The default handler throws from a timer, which would crash the
        // process.
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch (error) {
      // Reached only when a live writer held the lock through every retry.
      // A stream write has never failed because of its index, so update the
      // index without the lock rather than fail the write. `close()` checks
      // the index again.
      if (!warnedRunStreamsLockFailure) {
        warnedRunStreamsLockFailure = true;
        console.warn(
          `[world-local] Could not lock the stream index of run ${runId}; updating it without the lock:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    try {
      const streams = await readRunStreams(runId);
      if (!streams.includes(streamName)) {
        streams.push(streamName);
        await writeJSON(runStreamsPath, { streams }, { overwrite: true });
      }
    } finally {
      if (release && !compromised) {
        await release().catch(() => {});
      }
    }
    return !compromised;
  }

  function chunkPath(name: string, chunkId: string): string {
    return path.join(
      basedir,
      'streams',
      'chunks',
      `${name}-${chunkId}${tagSuffix}.bin`
    );
  }

  /** Writes one data chunk's file, then tells this instance's readers. */
  async function writeChunk(
    name: string,
    chunkId: string,
    chunkBuffer: Buffer
  ): Promise<void> {
    await write(
      chunkPath(name, chunkId),
      serializeChunk({ chunk: chunkBuffer, eof: false })
    );
    // Copy so a reader's enqueue cannot detach the caller's ArrayBuffer.
    streamEmitter.emit(`chunk:${name}` as const, {
      streamName: name,
      chunkData: Uint8Array.from(chunkBuffer),
      chunkId,
    });
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
    clearCache() {
      registeredStreams.clear();
    },

    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Generate ULID synchronously BEFORE any await to preserve call order.
      // This ensures that chunks written in sequence maintain their order even
      // when runId is a promise that multiple writes are waiting on.
      const chunkId = `chnk_${monotonicUlid()}`;
      const chunkBuffer = toBuffer(chunk);
      await withInProcessLock(streamWriteLocks, name, async () => {
        // Await runId if it's a promise to ensure proper flushing
        await registerStreamForRun(await _runId, name);
        await writeChunk(name, chunkId, chunkBuffer);
      });
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ) {
      if (chunks.length === 0) return;

      // Generate all ULIDs synchronously BEFORE any await to preserve call order.
      // This ensures that chunks maintain their order even when runId is a promise.
      const chunkIds = chunks.map(() => `chnk_${monotonicUlid()}`);
      const chunkBuffers = chunks.map((chunk) => toBuffer(chunk));
      await withInProcessLock(streamWriteLocks, name, async () => {
        await registerStreamForRun(await _runId, name);
        // One at a time: a reader listing the stream mid-group must not see
        // a later chunk before an earlier one.
        for (const [i, chunkBuffer] of chunkBuffers.entries()) {
          await writeChunk(name, chunkIds[i], chunkBuffer);
        }
      });
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      // Generate ULID synchronously BEFORE any await to preserve call order.
      const chunkId = `chnk_${monotonicUlid()}`;

      await withInProcessLock(streamWriteLocks, name, async () => {
        // Await runId if it's a promise to ensure proper flushing, register
        // this stream for the run (in case writeToStream wasn't called), and
        // put its name back if a writer outside this instance dropped it.
        await registerStreamForRun(await _runId, name, { verify: true });
        await write(
          chunkPath(name, chunkId),
          serializeChunk({ chunk: Buffer.from([]), eof: true })
        );
        streamEmitter.emit(`close:${name}` as const, { streamName: name });
      });
    },

    async listStreamsByRunId(runId: string) {
      assertSafeEntityId('runId', runId);
      return readRunStreams(runId);
    },

    async getStreamChunks(
      name: string,
      _runId: string,
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
          if (isEofByte(await readFirstByte(filePath))) {
            streamDone = true;
            break;
          }
          dataIndex++;
          continue;
        }

        // Collected enough data chunks — peek at the next file for EOF/hasMore
        if (resultChunks.length >= limit) {
          if (isEofByte(await readFirstByte(filePath))) {
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

    async getStreamInfo(
      name: string,
      _runId: string
    ): Promise<StreamInfoResponse> {
      const chunksDir = path.join(basedir, 'streams', 'chunks');
      const { files: chunkFiles, extMap: fileExtMap } =
        await listChunkFilesForStream(chunksDir, name, tag);

      // Read only the EOF marker byte because metadata never needs payloads.
      let streamDone = false;
      let dataCount = 0;
      for (const file of chunkFiles) {
        const ext = fileExtMap.get(file) ?? '.bin';
        if (
          isEofByte(await readFirstByte(path.join(chunksDir, `${file}${ext}`)))
        ) {
          streamDone = true;
          break;
        }
        dataCount++;
      }

      return { tailIndex: dataCount - 1, done: streamDone };
    },

    async readFromStream(name: string, startIndex = 0) {
      const chunksDir = path.join(basedir, 'streams', 'chunks');
      let removeListeners = () => {};
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Ids of chunks this reader has delivered, or must never deliver.
          const deliveredChunkIds = new Set<string>();
          // Live chunks that arrive while a disk read is in flight, by id. A
          // disk read delivers the files it lists in id order; holding live
          // chunks until it finishes keeps one from overtaking a listed chunk
          // with a smaller id.
          const bufferedEventChunks = new Map<string, Uint8Array>();
          // True during the initial disk read and during each poll.
          let isReadingFromDisk = true;
          // Buffer close event if it arrives during disk reading
          let pendingClose = false;
          // Set when the controller is closed; guards against enqueue-after-close
          // in the polling callback when closeListener fires mid-iteration.
          let streamClosed = false;

          // Chunk id of a listed chunk file, whose name is
          // "streamName-chunkId" or "streamName-chunkId.tag".
          const chunkIdForFile = (file: string): string => {
            const rawChunkId = file.substring(name.length + 1);
            // Strip tag suffix (e.g., "chnk_ULID.vitest-0" → "chnk_ULID")
            return tag ? rawChunkId.replace(`.${tag}`, '') : rawChunkId;
          };

          const deliver = (chunkId: string, chunkData: Uint8Array) => {
            if (streamClosed || deliveredChunkIds.has(chunkId)) return;
            deliveredChunkIds.add(chunkId);
            // Empty chunks are skipped, matching what a disk read delivers.
            if (chunkData.byteLength) {
              // Create a copy to prevent ArrayBuffer detachment
              controller.enqueue(Uint8Array.from(chunkData));
            }
          };

          const closeStream = () => {
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

          /** Delivers held live chunks in id order, then a held close. */
          const finishDiskRead = () => {
            isReadingFromDisk = false;
            // Same code-unit order as a disk read's sorted listing.
            const held = [...bufferedEventChunks].sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0
            );
            bufferedEventChunks.clear();
            for (const [chunkId, chunkData] of held) {
              deliver(chunkId, chunkData);
            }
            if (pendingClose) closeStream();
          };

          /** Delivers one listed chunk file; resolves `true` at end of stream. */
          const deliverFile = async (
            file: string,
            ext: string
          ): Promise<boolean> => {
            const chunkId = chunkIdForFile(file);
            if (deliveredChunkIds.has(chunkId)) return false;
            const live = bufferedEventChunks.get(chunkId);
            if (live !== undefined) {
              deliver(chunkId, live);
              return false;
            }
            const chunk = deserializeChunk(
              await readBuffer(path.join(chunksDir, `${file}${ext}`))
            );
            if (chunk?.eof === true) return true;
            deliver(chunkId, chunk.chunk);
            return false;
          };

          const chunkListener = (event: {
            streamName: string;
            chunkData: Uint8Array;
            chunkId: string;
          }) => {
            if (isReadingFromDisk) {
              // Create a copy to prevent ArrayBuffer detachment when enqueued later
              bufferedEventChunks.set(
                event.chunkId,
                Uint8Array.from(event.chunkData)
              );
              return;
            }
            deliver(event.chunkId, event.chunkData);
          };

          const closeListener = () => {
            // Buffer close event if disk reading is still in progress
            if (isReadingFromDisk) {
              pendingClose = true;
              return;
            }
            closeStream();
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
            if (
              isEofByte(
                await readFirstByte(
                  path.join(chunksDir, `${lastFile}${lastExt}`)
                )
              )
            ) {
              dataChunkCount--;
            }
          }
          const resolvedStartIndex =
            typeof startIndex === 'number' && startIndex < 0
              ? Math.max(0, dataChunkCount + startIndex)
              : startIndex;

          // Chunks before startIndex are never delivered, not even as a
          // live copy that arrives during the read.
          for (
            let i = 0;
            i < resolvedStartIndex && i < chunkFiles.length;
            i++
          ) {
            deliveredChunkIds.add(chunkIdForFile(chunkFiles[i]));
          }

          let isComplete = false;
          for (let i = resolvedStartIndex; i < chunkFiles.length; i++) {
            const file = chunkFiles[i];
            if (await deliverFile(file, fileExtMap.get(file) ?? '.bin')) {
              isComplete = true;
              break;
            }
          }
          finishDiskRead();

          if (isComplete) {
            closeStream();
            return;
          }

          // A close event that arrived during the disk read closed the stream
          // in finishDiskRead(); don't arm a poll behind it.
          if (streamClosed) return;

          // Start filesystem polling for cross-process streaming support.
          // The EventEmitter only works in-process; when the writer is in a
          // separate process (e.g. e2e test runner ↔ workbench app), polling
          // the shared filesystem is the fallback delivery mechanism.
          let isPolling = false;
          pollInterval = setInterval(async () => {
            if (isPolling || streamClosed) return;
            isPolling = true;
            isReadingFromDisk = true;
            let readEveryListedFile = false;
            try {
              const { files: currentFiles, extMap: currentExtMap } =
                await listChunkFilesForStream(chunksDir, name, tag);

              for (const file of currentFiles) {
                if (
                  await deliverFile(file, currentExtMap.get(file) ?? '.bin')
                ) {
                  finishDiskRead();
                  closeStream();
                  return;
                }
                // closeListener or cancel() may have closed the stream
                // while the file was read.
                if (streamClosed) return;
              }
              readEveryListedFile = true;
            } catch (err: unknown) {
              // Silently ignore transient filesystem errors (ENOENT, EACCES, etc.)
              // Surface unexpected errors so bugs aren't hidden
              if (!(err instanceof Error && 'code' in err)) {
                console.error('[world-local] Unexpected polling error:', err);
              }
            } finally {
              isPolling = false;
              // A poll that failed partway keeps holding live chunks: the
              // next poll delivers the listed files it did not reach first.
              if (readEveryListedFile && !streamClosed) finishDiskRead();
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
  };
}
