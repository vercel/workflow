import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import type { Db } from './db.js';
import { assertSafeEntityId, monotonicUlid } from './storage/common.js';

/** Sorts before every real chunk id: marks a stream purged by retention. */
const PURGED_STREAM_TOMBSTONE_ID = `chnk_${'0'.repeat(26)}`;

/** How often a tailing reader checks for chunks written by other processes. */
export const STREAM_POLL_INTERVAL_MS = 100;

type StreamEvents = {
  [key: `chunk:${string}`]: [
    { streamName: string; chunkData: Uint8Array; chunkId: string },
  ];
  [key: `close:${string}`]: [{ streamName: string }];
};

// One emitter per connection, so every streamer sharing a connection hears
// that connection's writes (which `PRAGMA data_version` doesn't report).
const emitters = new WeakMap<Db, EventEmitter<StreamEvents>>();

function emitterFor(db: Db): EventEmitter<StreamEvents> {
  let emitter = emitters.get(db);
  if (!emitter) {
    emitter = new EventEmitter<StreamEvents>();
    emitter.setMaxListeners(0);
    emitters.set(db, emitter);
  }
  return emitter;
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  return Uint8Array.from(chunk);
}

interface ChunkRow {
  chunk_id: string;
  eof: number;
  data: Uint8Array;
}

/**
 * Tombstones a run's streams and drops their chunks (zero-retention purge).
 * Runs inside the caller's transaction.
 */
export function purgeRunStreamData(db: Db, runId: string, tag: string): void {
  const names = db
    .all<{ stream_name: string }>(
      'SELECT stream_name FROM run_streams WHERE run_id = ? AND tag IN (?, ?)',
      runId,
      tag,
      ''
    )
    .map((row) => row.stream_name);
  for (const name of names) {
    db.run(
      'DELETE FROM stream_chunks WHERE stream_name = ? AND chunk_id != ?',
      name,
      PURGED_STREAM_TOMBSTONE_ID
    );
    db.run(
      `INSERT INTO stream_chunks (stream_name, chunk_id, tag, eof, data)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (stream_name, chunk_id) DO NOTHING`,
      name,
      PURGED_STREAM_TOMBSTONE_ID,
      tag,
      new Uint8Array(0)
    );
  }
}

export function createStreamer(db: Db, tag?: string): Streamer {
  const tagValue = tag ?? '';
  const emitter = emitterFor(db);
  const registeredStreams = new Set<string>();

  function registerStreamForRun(runId: string, streamName: string): void {
    assertSafeEntityId('runId', runId);
    assertSafeEntityId('streamName', streamName);
    const key = `${runId}:${streamName}`;
    if (registeredStreams.has(key)) return;
    db.run(
      `INSERT INTO run_streams (run_id, stream_name, tag, position)
       VALUES (?, ?, ?, (SELECT count(*) FROM run_streams WHERE run_id = ?))
       ON CONFLICT (run_id, stream_name) DO NOTHING`,
      runId,
      streamName,
      tagValue,
      runId
    );
    registeredStreams.add(key);
  }

  function insertChunk(
    name: string,
    chunkId: string,
    data: Uint8Array,
    eof: boolean
  ): void {
    db.run(
      'INSERT INTO stream_chunks (stream_name, chunk_id, tag, eof, data) VALUES (?, ?, ?, ?, ?)',
      name,
      chunkId,
      tagValue,
      eof ? 1 : 0,
      data
    );
  }

  function readChunks(name: string): ChunkRow[] {
    assertSafeEntityId('streamName', name);
    return db.all<ChunkRow>(
      'SELECT chunk_id, eof, data FROM stream_chunks WHERE stream_name = ? ORDER BY chunk_id',
      name
    );
  }

  function readChunkHeads(name: string): { chunk_id: string; eof: number }[] {
    assertSafeEntityId('streamName', name);
    return db.all<{ chunk_id: string; eof: number }>(
      'SELECT chunk_id, eof FROM stream_chunks WHERE stream_name = ? ORDER BY chunk_id',
      name
    );
  }

  return {
    streams: {
      async write(
        _runId: string | Promise<string>,
        name: string,
        chunk: string | Uint8Array
      ) {
        // Minted before the await so concurrent writes keep call order.
        const chunkId = `chnk_${monotonicUlid()}`;
        const runId = await _runId;
        const bytes = toBytes(chunk);
        db.transaction(() => {
          registerStreamForRun(runId, name);
          insertChunk(name, chunkId, bytes, false);
        });
        emitter.emit(`chunk:${name}`, {
          streamName: name,
          chunkData: bytes,
          chunkId,
        });
      },

      async writeMulti(
        _runId: string | Promise<string>,
        name: string,
        chunks: (string | Uint8Array)[]
      ) {
        if (chunks.length === 0) return;
        const chunkIds = chunks.map(() => `chnk_${monotonicUlid()}`);
        const runId = await _runId;
        const payloads = chunks.map(toBytes);
        db.transaction(() => {
          registerStreamForRun(runId, name);
          payloads.forEach((bytes, i) => {
            insertChunk(name, chunkIds[i], bytes, false);
          });
        });
        payloads.forEach((bytes, i) => {
          emitter.emit(`chunk:${name}`, {
            streamName: name,
            chunkData: bytes,
            chunkId: chunkIds[i],
          });
        });
      },

      async close(_runId: string | Promise<string>, name: string) {
        const chunkId = `chnk_${monotonicUlid()}`;
        const runId = await _runId;
        db.transaction(() => {
          registerStreamForRun(runId, name);
          insertChunk(name, chunkId, new Uint8Array(0), true);
        });
        emitter.emit(`close:${name}`, { streamName: name });
      },

      async list(runId: string) {
        assertSafeEntityId('runId', runId);
        return db
          .all<{ stream_name: string }>(
            'SELECT stream_name FROM run_streams WHERE run_id = ? AND tag IN (?, ?) ORDER BY position, stream_name',
            runId,
            tagValue,
            ''
          )
          .map((row) => row.stream_name);
      },

      async getChunks(
        _runId: string,
        name: string,
        options?: GetChunksOptions
      ): Promise<StreamChunksResponse> {
        const limit = options?.limit ?? 100;
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
        const heads = readChunkHeads(name);
        let streamDone = false;
        const wanted: { index: number; chunkId: string }[] = [];
        let dataIndex = 0;
        for (const head of heads) {
          if (dataIndex < startIndex) {
            if (head.eof) {
              streamDone = true;
              break;
            }
            dataIndex++;
            continue;
          }
          if (wanted.length >= limit) {
            if (head.eof) streamDone = true;
            else dataIndex++;
            break;
          }
          if (head.eof) {
            streamDone = true;
            break;
          }
          wanted.push({ index: dataIndex, chunkId: head.chunk_id });
          dataIndex++;
        }
        const data = wanted.map(({ index, chunkId }) => {
          const row = db.get<{ data: Uint8Array }>(
            'SELECT data FROM stream_chunks WHERE stream_name = ? AND chunk_id = ?',
            name,
            chunkId
          );
          return {
            index,
            data: Uint8Array.from(row?.data ?? new Uint8Array(0)),
          };
        });
        const hasMore = !streamDone && dataIndex > startIndex + data.length;
        const nextIndex = startIndex + data.length;
        return {
          data,
          cursor: hasMore
            ? Buffer.from(JSON.stringify({ i: nextIndex })).toString('base64')
            : null,
          hasMore,
          done: streamDone,
        };
      },

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        let streamDone = false;
        let dataCount = 0;
        for (const head of readChunkHeads(name)) {
          if (head.eof) {
            streamDone = true;
            break;
          }
          dataCount++;
        }
        return { tailIndex: dataCount - 1, done: streamDone };
      },

      async get(_runId: string, name: string, startIndex = 0) {
        assertSafeEntityId('streamName', name);
        let teardown = () => {};
        let pollInterval: ReturnType<typeof setInterval> | null = null;
        let streamClosed = false;

        return new ReadableStream<Uint8Array>({
          start(controller) {
            const delivered = new Set<string>();
            const buffered: { chunkId: string; chunkData: Uint8Array }[] = [];
            let readingBacklog = true;
            let pendingClose = false;

            const close = () => {
              streamClosed = true;
              teardown();
              try {
                controller.close();
              } catch {
                // Already closed or cancelled.
              }
            };

            const chunkListener = (event: {
              chunkData: Uint8Array;
              chunkId: string;
            }) => {
              if (event.chunkData.byteLength === 0) {
                delivered.add(event.chunkId);
                return;
              }
              if (readingBacklog) {
                delivered.add(event.chunkId);
                buffered.push({
                  chunkId: event.chunkId,
                  chunkData: Uint8Array.from(event.chunkData),
                });
              } else if (!delivered.has(event.chunkId)) {
                delivered.add(event.chunkId);
                controller.enqueue(Uint8Array.from(event.chunkData));
              }
            };
            const closeListener = () => {
              if (readingBacklog) {
                pendingClose = true;
                return;
              }
              close();
            };
            teardown = () => {
              emitter.off(`chunk:${name}`, chunkListener);
              emitter.off(`close:${name}`, closeListener);
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
            };
            emitter.on(`chunk:${name}`, chunkListener);
            emitter.on(`close:${name}`, closeListener);

            const rows = readChunks(name);
            let dataChunkCount = rows.length;
            if (startIndex < 0 && rows.length > 0 && rows.at(-1)!.eof) {
              dataChunkCount--;
            }
            const resolvedStart =
              startIndex < 0
                ? Math.max(0, dataChunkCount + startIndex)
                : startIndex;

            let complete = false;
            for (let i = resolvedStart; i < rows.length; i++) {
              const row = rows[i];
              if (delivered.has(row.chunk_id)) continue;
              if (row.eof) {
                complete = true;
                break;
              }
              delivered.add(row.chunk_id);
              if (row.data.byteLength) {
                controller.enqueue(Uint8Array.from(row.data));
              }
            }
            readingBacklog = false;
            buffered.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
            for (const chunk of buffered) {
              controller.enqueue(chunk.chunkData);
            }
            if (complete || pendingClose) {
              close();
              return;
            }
            for (let i = 0; i < resolvedStart && i < rows.length; i++) {
              delivered.add(rows[i].chunk_id);
            }
            if (streamClosed) {
              teardown();
              return;
            }

            // Another process's writes: poll, and only query when
            // `data_version` says some other connection committed.
            let lastVersion = db.isOpen ? db.dataVersion() : 0;
            pollInterval = setInterval(() => {
              if (streamClosed || !db.isOpen) {
                if (!db.isOpen) teardown();
                return;
              }
              try {
                const version = db.dataVersion();
                if (version === lastVersion) return;
                lastVersion = version;
                for (const head of readChunkHeads(name)) {
                  if (delivered.has(head.chunk_id)) continue;
                  delivered.add(head.chunk_id);
                  if (head.eof) {
                    close();
                    return;
                  }
                  const row = db.get<{ data: Uint8Array }>(
                    'SELECT data FROM stream_chunks WHERE stream_name = ? AND chunk_id = ?',
                    name,
                    head.chunk_id
                  );
                  if (row && row.data.byteLength) {
                    controller.enqueue(Uint8Array.from(row.data));
                  }
                }
              } catch (error) {
                console.error(
                  '[world-sqlite] Unexpected polling error:',
                  error
                );
              }
            }, STREAM_POLL_INTERVAL_MS);
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
