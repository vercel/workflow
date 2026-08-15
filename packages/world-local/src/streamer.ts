import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lock } from 'proper-lockfile';
import type {
  GetChunksOptions,
  KeyedStreamAppendRequest,
  KeyedStreamAppendResult,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
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

const EOF_MARKER = 1;

interface KeyedReceipt {
  idempotencyKey: string;
  semanticDigest: string;
  chunkId: string;
  index: number;
  canonicalChunk: string;
}

interface KeyedRecord extends KeyedReceipt {
  physicalId: string;
}

interface KeyedLedger {
  version: 1;
  runId: string;
  streamName: string;
  records: KeyedRecord[];
  closed?: boolean;
}

const KeyedLedgerSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  streamName: z.string(),
  records: z.array(
    z.object({
      idempotencyKey: z.string(),
      semanticDigest: z.string(),
      chunkId: z.string(),
      index: z.number().int().nonnegative(),
      canonicalChunk: z.string(),
      physicalId: z.string(),
    })
  ),
  closed: z.boolean().optional(),
});

function keyedFileId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function keyedLedgerPath(
  basedir: string,
  runId: string,
  streamName: string,
  tag?: string
): string {
  return path.join(
    basedir,
    'streams',
    'keyed-v1',
    keyedFileId(runId),
    `${keyedFileId(streamName)}${tag ? `.${tag}` : ''}.json`
  );
}

async function readKeyedLedger(
  basedir: string,
  runId: string,
  streamName: string,
  tag?: string
): Promise<KeyedLedger | null> {
  try {
    const parsed = KeyedLedgerSchema.parse(
      JSON.parse(
        await fs.readFile(
          keyedLedgerPath(basedir, runId, streamName, tag),
          'utf8'
        )
      )
    );
    if (parsed.runId !== runId || parsed.streamName !== streamName) {
      throw new Error('corrupt keyed stream ledger');
    }
    if (parsed.records.some((record, index) => record.index !== index)) {
      throw new Error('corrupt keyed stream ledger');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function withKeyedLedger<T>(
  basedir: string,
  runId: string,
  streamName: string,
  tag: string | undefined,
  fn: (file: string, ledger: KeyedLedger | null) => Promise<T>
): Promise<T> {
  const file = keyedLedgerPath(basedir, runId, streamName, tag);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await lock(file, {
    realpath: false,
    stale: 30_000,
    update: 1_000,
    retries: { retries: 300, factor: 1, minTimeout: 10, maxTimeout: 10 },
  });
  try {
    return await fn(
      file,
      await readKeyedLedger(basedir, runId, streamName, tag)
    );
  } finally {
    await release();
  }
}

async function writeKeyedLedger(
  file: string,
  ledger: KeyedLedger
): Promise<void> {
  const temporary = `${file}.${process.pid}.${monotonicUlid()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(ledger));
  await fs.rename(temporary, file);
}

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
 * Resolve the per-stream chunk directory. Chunks are sharded one directory
 * per stream (`streams/chunks/<streamName>/`) so that listing a stream's
 * chunks costs O(chunks in that stream) rather than O(chunks in the whole
 * world). A tail reader polling for new chunks would otherwise `readdir` the
 * entire global chunks directory every 100ms — see vercel/workflow#2797.
 */
function chunkDirForStream(chunksBaseDir: string, name: string): string {
  // Name becomes a path segment below; validate it can't escape chunksBaseDir.
  assertSafeEntityId('streamName', name);
  return path.join(chunksBaseDir, name);
}

/**
 * List chunk files for a stream, sorted chronologically (ULID order).
 * Returns the sorted chunk keys (each key is the chunk ULID), a map of
 * key → extension for resolving the full path, and the per-stream directory
 * the files live in. Handles tagged and legacy (.json) formats.
 *
 * Files are stored per-stream (`<chunkDir>/<chunkId><tagSuffix>.bin`), so the
 * key returned here is already the chunk id — no stream-name prefix to strip.
 */
async function listChunkFilesForStream(
  chunksBaseDir: string,
  name: string,
  tag?: string
): Promise<{ files: string[]; extMap: Map<string, string>; dir: string }> {
  const dir = chunkDirForStream(chunksBaseDir, name);
  const entries = await listChunkEntries(dir);
  const extMap = new Map<string, string>();
  addChunkFilesByExtension(extMap, entries, '.json');
  addChunkFilesByExtension(
    extMap,
    entries,
    '.bin',
    '.bin',
    tag
      ? (file) => !file.endsWith(`.${tag}`) && !file.startsWith('keyed_')
      : (file) => !file.startsWith('keyed_')
  );

  if (tag) {
    const taggedExtension = `.${tag}.bin`;
    addChunkFilesByExtension(
      extMap,
      entries,
      taggedExtension,
      taggedExtension,
      (file) => !file.startsWith('keyed_')
    );
  }

  const files = [...extMap.keys()].sort();

  return { files, extMap, dir };
}

export function createStreamer(basedir: string, tag?: string): Streamer {
  const tagSuffix = tag ? `.${tag}` : '';
  const streamEmitter = new EventEmitter<{
    [key: `chunk:${string}`]: [
      {
        runId: string;
        streamName: string;
        chunkData: Uint8Array;
        chunkId: string;
      },
    ];
    [key: `close:${string}`]: [
      {
        runId: string;
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

  const appendKeyed = async (
    runId: string,
    name: string,
    request: KeyedStreamAppendRequest
  ): Promise<KeyedStreamAppendResult> => {
    assertSafeEntityId('runId', runId);
    assertSafeEntityId('streamName', name);
    const materialize = async (record: KeyedRecord): Promise<Uint8Array> => {
      const canonicalChunk = Uint8Array.from(
        Buffer.from(record.canonicalChunk, 'base64')
      );
      const chunkPath = path.join(
        chunkDirForStream(path.join(basedir, 'streams', 'chunks'), name),
        `${record.physicalId}${tagSuffix}.bin`
      );
      const expected = serializeChunk({
        chunk: Buffer.from(canonicalChunk),
        eof: false,
      });
      try {
        const actual = await readBuffer(chunkPath);
        if (!actual.equals(expected))
          throw new Error('corrupt keyed stream chunk');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // The ledger lock owns this physical identity; the fs existence cache
        // may outlive a crash/cleanup, so repair must not consult it as authority.
        await write(chunkPath, expected, { overwrite: true });
      }
      return canonicalChunk;
    };

    return withKeyedLedger(basedir, runId, name, tag, async (file, current) => {
      const existing = current?.records.find(
        (record) => record.idempotencyKey === request.idempotencyKey
      );
      if (existing) {
        if (existing.semanticDigest !== request.semanticDigest) {
          throw new Error(
            'Keyed stream append retried with a different digest'
          );
        }
        return {
          inserted: false,
          canonicalChunk: await materialize(existing),
          index: existing.index,
        };
      }

      if (current?.closed) {
        throw new Error('closed keyed stream');
      }
      if (!current) {
        const ordinary = await listChunkFilesForStream(
          path.join(basedir, 'streams', 'chunks'),
          name,
          tag
        );
        if (ordinary.files.length > 0) {
          throw new Error('mixed keyed/unkeyed stream data');
        }
      }

      await registerStreamForRun(runId, name);
      const chunk = toBuffer(request.chunk);
      const index = current?.records.length ?? 0;
      const record: KeyedRecord = {
        idempotencyKey: request.idempotencyKey,
        semanticDigest: request.semanticDigest,
        chunkId: `chnk_${monotonicUlid()}`,
        index,
        canonicalChunk: chunk.toString('base64'),
        // The padded ledger index is the physical order for cross-process tailers.
        physicalId: `keyed_${keyedFileId(runId).slice(0, 16)}_${String(index).padStart(12, '0')}`,
      };
      await writeKeyedLedger(file, {
        version: 1,
        runId,
        streamName: name,
        records: [...(current?.records ?? []), record],
        closed: false,
      });
      const canonicalChunk = await materialize(record);
      streamEmitter.emit(`chunk:${name}` as const, {
        runId,
        streamName: name,
        chunkData: canonicalChunk,
        chunkId: record.physicalId,
      });
      return { inserted: true, canonicalChunk, index };
    });
  };

  return {
    keyedStreamAppendVersion: 1,
    streams: {
      appendKeyed,
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

        if (await readKeyedLedger(basedir, runId, name, tag)) {
          throw new Error('mixed keyed/unkeyed stream data');
        }

        // Register this stream for the run
        await registerStreamForRun(runId, name);

        // Convert chunk to buffer for serialization
        const chunkBuffer = toBuffer(chunk);

        const serialized = serializeChunk({
          chunk: chunkBuffer,
          eof: false,
        });

        const chunkPath = path.join(
          chunkDirForStream(path.join(basedir, 'streams', 'chunks'), name),
          `${chunkId}${tagSuffix}.bin`
        );

        await write(chunkPath, serialized);

        // Emit real-time event with Uint8Array (create copy to prevent ArrayBuffer detachment)
        const chunkData = Uint8Array.from(chunkBuffer);

        streamEmitter.emit(`chunk:${name}` as const, {
          runId,
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

        if (await readKeyedLedger(basedir, runId, name, tag)) {
          throw new Error('mixed keyed/unkeyed stream data');
        }

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
            chunkDirForStream(path.join(basedir, 'streams', 'chunks'), name),
            `${chunkId}${tagSuffix}.bin`
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
            runId,
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

        const closedKeyed = await withKeyedLedger(
          basedir,
          runId,
          name,
          tag,
          async (file, keyed) => {
            if (!keyed) return false;
            if (!keyed.closed) {
              await writeKeyedLedger(file, { ...keyed, closed: true });
            }
            return true;
          }
        );
        if (closedKeyed) {
          streamEmitter.emit(`close:${name}` as const, {
            runId,
            streamName: name,
          });
          return;
        }

        // Register this stream for the run (in case write wasn't called)
        await registerStreamForRun(runId, name);
        const chunkPath = path.join(
          chunkDirForStream(path.join(basedir, 'streams', 'chunks'), name),
          `${chunkId}${tagSuffix}.bin`
        );

        await write(
          chunkPath,
          serializeChunk({ chunk: Buffer.from([]), eof: true })
        );

        streamEmitter.emit(`close:${name}` as const, {
          runId,
          streamName: name,
        });
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
        runId: string,
        name: string,
        options?: GetChunksOptions
      ): Promise<StreamChunksResponse> {
        const limit = options?.limit ?? 100;
        const keyed = await readKeyedLedger(basedir, runId, name, tag);
        if (keyed) {
          let startIndex = 0;
          if (options?.cursor) {
            try {
              startIndex = JSON.parse(
                Buffer.from(options.cursor, 'base64').toString('utf-8')
              ).i;
            } catch {
              startIndex = 0;
            }
          }
          const records = keyed.records.slice(startIndex, startIndex + limit);
          const nextIndex = startIndex + records.length;
          const hasMore = nextIndex < keyed.records.length;
          return {
            data: records.map((record) => ({
              index: record.index,
              data: Uint8Array.from(
                Buffer.from(record.canonicalChunk, 'base64')
              ),
            })),
            cursor: hasMore
              ? Buffer.from(JSON.stringify({ i: nextIndex })).toString('base64')
              : null,
            hasMore,
            done: keyed.closed === true,
          };
        }
        const chunksBaseDir = path.join(basedir, 'streams', 'chunks');
        const {
          files: chunkFiles,
          extMap: fileExtMap,
          dir: chunksDir,
        } = await listChunkFilesForStream(chunksBaseDir, name, tag);

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

      async getInfo(runId: string, name: string): Promise<StreamInfoResponse> {
        const keyed = await readKeyedLedger(basedir, runId, name, tag);
        if (keyed)
          return {
            tailIndex: keyed.records.length - 1,
            done: keyed.closed === true,
          };
        const chunksBaseDir = path.join(basedir, 'streams', 'chunks');
        const {
          files: chunkFiles,
          extMap: fileExtMap,
          dir: chunksDir,
        } = await listChunkFilesForStream(chunksBaseDir, name, tag);

        // Read only the EOF marker byte because metadata never needs payloads.
        let streamDone = false;
        let dataCount = 0;
        for (const file of chunkFiles) {
          const ext = fileExtMap.get(file) ?? '.bin';
          if (
            isEofByte(
              await readFirstByte(path.join(chunksDir, `${file}${ext}`))
            )
          ) {
            streamDone = true;
            break;
          }
          dataCount++;
        }

        return { tailIndex: dataCount - 1, done: streamDone };
      },

      async get(runId: string, name: string, startIndex = 0) {
        const keyedAtOpen = await readKeyedLedger(basedir, runId, name, tag);
        if (keyedAtOpen) {
          // Keyed v1 readers consume the ledger, not directory enumeration:
          // the ledger is the sole authority for run-scoped order and bytes.
          let teardown = () => {};
          return new ReadableStream<Uint8Array>({
            async start(controller) {
              let next =
                startIndex < 0
                  ? Math.max(0, keyedAtOpen.records.length + startIndex)
                  : startIndex;
              let flushing = false;
              const flush = async () => {
                if (flushing) return;
                flushing = true;
                try {
                  const ledger = await readKeyedLedger(
                    basedir,
                    runId,
                    name,
                    tag
                  );
                  if (!ledger) throw new Error('missing keyed stream ledger');
                  for (; next < ledger.records.length; next++) {
                    controller.enqueue(
                      Uint8Array.from(
                        Buffer.from(
                          ledger.records[next].canonicalChunk,
                          'base64'
                        )
                      )
                    );
                  }
                  if (ledger.closed) {
                    teardown();
                    controller.close();
                  }
                } catch (error) {
                  controller.error(error);
                } finally {
                  flushing = false;
                }
              };
              const listener = (event: { runId: string }) => {
                if (event.runId === runId) void flush();
              };
              const closeListener = (event: { runId: string }) => {
                if (event.runId === runId) void flush();
              };
              streamEmitter.on(`chunk:${name}` as const, listener);
              streamEmitter.on(`close:${name}` as const, closeListener);
              const interval = setInterval(() => void flush(), 100);
              teardown = () => {
                clearInterval(interval);
                streamEmitter.off(`chunk:${name}` as const, listener);
                streamEmitter.off(`close:${name}` as const, closeListener);
              };
              await flush();
            },
            cancel() {
              teardown();
            },
          });
        }
        const chunksBaseDir = path.join(basedir, 'streams', 'chunks');
        // Tears down everything the reader holds open: both emitter listeners
        // and the filesystem poll interval. Assigned once listeners are wired
        // up in start(); called on cancel() and on terminal (EOF/close) paths.
        // Kept robust (unconditional) so a cancel() while still reading from
        // disk can't leak a listener/poll — a signal-bearing step opens one of
        // these readers per invocation, so any leak accumulates fast.
        let teardown = () => {};
        let pollInterval: ReturnType<typeof setInterval> | null = null;
        // Set when the controller is closed/cancelled; guards against
        // enqueue-after-close in the polling callback when teardown fires
        // mid-iteration.
        let streamClosed = false;

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
              runId: string;
              streamName: string;
              chunkData: Uint8Array;
              chunkId: string;
            }) => {
              if (event.runId !== runId) return;
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

            const closeListener = (event: { runId: string }) => {
              if (event.runId !== runId) return;
              // Buffer close event if disk reading is still in progress
              if (isReadingFromDisk) {
                pendingClose = true;
                return;
              }
              // Remove listeners before closing
              streamClosed = true;
              teardown();
              try {
                controller.close();
              } catch {
                // Ignore if controller is already closed (e.g., from cancel() or EOF)
              }
            };
            // Tear down listeners and the poll unconditionally. Unlike
            // closeListener this never defers on isReadingFromDisk, so cancel()
            // reliably releases the reader even mid-disk-read.
            teardown = () => {
              streamEmitter.off(`chunk:${name}` as const, chunkListener);
              streamEmitter.off(`close:${name}` as const, closeListener);
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
            };

            // Set up listeners FIRST to avoid missing events
            streamEmitter.on(`chunk:${name}` as const, chunkListener);
            streamEmitter.on(`close:${name}` as const, closeListener);

            // Now load existing chunks from disk.
            const {
              files: chunkFiles,
              extMap: fileExtMap,
              dir: chunksDir,
            } = await listChunkFilesForStream(chunksBaseDir, name, tag);

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

            // Process existing chunks, skipping any already delivered via events
            let isComplete = false;
            for (let i = resolvedStartIndex; i < chunkFiles.length; i++) {
              const file = chunkFiles[i];
              // Files are sharded per stream, so the key is already the chunk id
              // (no stream-name prefix, tag suffix already stripped).
              const chunkId = file;

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
              streamClosed = true;
              teardown();
              try {
                controller.close();
              } catch {
                // Ignore if controller is already closed (e.g., from closeListener event)
              }
              return;
            }

            // Process any pending close event that arrived during disk reading
            if (pendingClose) {
              streamClosed = true;
              teardown();
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
              // Files are sharded per stream: the key is already the chunk id.
              deliveredChunkIds.add(chunkFiles[i]);
            }

            // If the reader was already cancelled/closed while we were reading
            // from disk above (start() yields at every await), don't arm the
            // poll — cancel()'s teardown ran before this point and would leave
            // the freshly-created interval orphaned.
            if (streamClosed) {
              teardown();
              return;
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
                const keyed = await readKeyedLedger(basedir, runId, name, tag);
                if (keyed) {
                  for (const record of keyed.records) {
                    if (deliveredChunkIds.has(record.physicalId)) continue;
                    deliveredChunkIds.add(record.physicalId);
                    if (!streamClosed) {
                      controller.enqueue(
                        Uint8Array.from(
                          Buffer.from(record.canonicalChunk, 'base64')
                        )
                      );
                    }
                  }
                  if (keyed.closed) {
                    streamClosed = true;
                    teardown();
                    controller.close();
                  }
                  return;
                }
                const { files: currentFiles, extMap: currentExtMap } =
                  await listChunkFilesForStream(chunksBaseDir, name, tag);

                for (const file of currentFiles) {
                  // Files are sharded per stream: the key is already the chunk id.
                  const chunkId = file;

                  if (deliveredChunkIds.has(chunkId)) continue;
                  deliveredChunkIds.add(chunkId);

                  const ext = currentExtMap.get(file) ?? '.bin';
                  const chunk = deserializeChunk(
                    await readBuffer(path.join(chunksDir, `${file}${ext}`))
                  );

                  if (chunk?.eof === true) {
                    streamClosed = true;
                    teardown();
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
            streamClosed = true;
            teardown();
          },
        });
      },
    },
  };
}
