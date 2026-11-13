/**
 * Run streams, stored as rows of `stream_chunks` in the data directory's
 * database.
 *
 * A chunk's index is assigned in the transaction that inserts it (one past
 * the stream's last), so a stream's chunks are totally ordered at commit,
 * densely numbered, and never reordered or duplicated for a reader: a reader
 * that opens mid-write sees the committed prefix and then the rest, in index
 * order. The end of a stream is a row with `eof = 1` after its last chunk.
 *
 * Readers in this process are woken by an in-process signal; readers in
 * other processes (a test runner reading an app's stream) poll for rows past
 * the last index they delivered, an index seek however long the stream is.
 */

import { EventEmitter } from 'node:events';
import { globalSingleton } from '@workflow/utils';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { type Database, databaseFor } from './db/index.js';

/** How often a reader checks for chunks written by another process. */
const POLL_INTERVAL_MS = 100;

/** Reads that fail in a row before a reader gives up with the error. */
const MAX_CONSECUTIVE_READ_FAILURES = 50;

const signals = globalSingleton(
  '@workflow/world-local//streamSignals',
  1,
  () => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    return { emitter };
  }
);

function signalKey(db: Database, name: string): string {
  return `${db.file}\0${name}`;
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
}

interface ChunkRow {
  idx: number;
  data: Uint8Array | null;
  eof: number;
}

export function createStreamer(
  basedir: string,
  tag?: string
): Streamer & {
  /** Kept for callers of the filesystem implementation; nothing to clear. */
  clearCache(): void;
} {
  const db = databaseFor(basedir);
  // Writes to one stream from this instance land in call order, even when
  // their runId is a promise several writes are waiting on.
  const turns = new Map<string, Promise<unknown>>();

  function inTurn<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = turns.get(name) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    turns.set(name, next);
    const forget = () => {
      if (turns.get(name) === next) turns.delete(name);
    };
    // Both outcomes handled: a failed write rejects for its caller only.
    next.then(forget, forget);
    return next;
  }

  /**
   * The stream's last row: one primary-key seek, however long the stream.
   * The end marker is always the last row (see `append`), so this is also
   * how a reader learns the stream has ended.
   */
  function lastRow(name: string): { idx: number; eof: boolean } | undefined {
    const row = db.get<{ idx: number; eof: number }>(
      'SELECT idx, eof FROM stream_chunks WHERE name = ? ORDER BY idx DESC LIMIT 1',
      name
    );
    return row
      ? { idx: Number(row.idx), eof: Number(row.eof) === 1 }
      : undefined;
  }

  /**
   * Appends chunks (and optionally the end marker) in one transaction. A
   * stream that has ended takes nothing more, so its end marker stays its
   * last row.
   */
  async function append(
    runId: string,
    name: string,
    chunks: Uint8Array[],
    eof: boolean
  ): Promise<void> {
    // Waits for another process's write lock without blocking the thread.
    const appended = await db.transactAsync(() => {
      const last = lastRow(name);
      if (last?.eof) return false;
      let idx = last?.idx ?? 0;
      for (const chunk of chunks) {
        idx++;
        db.run(
          'INSERT INTO stream_chunks (name, idx, run_id, tag, data, eof) VALUES (?, ?, ?, ?, ?, 0)',
          name,
          idx,
          runId,
          tag ?? null,
          chunk
        );
      }
      if (eof) {
        idx++;
        db.run(
          'INSERT INTO stream_chunks (name, idx, run_id, tag, data, eof) VALUES (?, ?, ?, ?, NULL, 1)',
          name,
          idx,
          runId,
          tag ?? null
        );
      }
      return true;
    });
    if (appended) signals.emitter.emit(signalKey(db, name));
  }

  function rowsAfter(
    name: string,
    afterIdx: number,
    limit?: number
  ): ChunkRow[] {
    const rows = db.all<ChunkRow>(
      `SELECT idx, data, eof FROM stream_chunks WHERE name = ? AND idx > ? ORDER BY idx${
        limit === undefined ? '' : ' LIMIT ?'
      }`,
      name,
      afterIdx,
      ...(limit === undefined ? [] : [limit])
    );
    return rows.map((row) => ({
      idx: Number(row.idx),
      data: row.data ? new Uint8Array(row.data) : null,
      eof: Number(row.eof),
    }));
  }

  /** Data chunks so far, and whether the stream has ended. */
  function info(name: string): { count: number; done: boolean } {
    // Data chunks are numbered from 1 with no gaps, and the end marker comes
    // right after the last one (a purged stream has only its marker, at 0).
    const last = lastRow(name);
    if (!last) return { count: 0, done: false };
    return {
      count: Math.max(0, last.eof ? last.idx - 1 : last.idx),
      done: last.eof,
    };
  }

  return {
    clearCache() {},

    streams: {
      async write(_runId: string | Promise<string>, name: string, chunk) {
        const bytes = toBytes(chunk);
        await inTurn(name, async () => {
          const runId = await _runId;
          await append(runId, name, [bytes], false);
        });
      },

      async writeMulti(
        _runId: string | Promise<string>,
        name: string,
        chunks: (string | Uint8Array)[]
      ) {
        if (chunks.length === 0) return;
        const bytes = chunks.map(toBytes);
        await inTurn(name, async () => {
          const runId = await _runId;
          await append(runId, name, bytes, false);
        });
      },

      async close(_runId: string | Promise<string>, name: string) {
        await inTurn(name, async () => {
          const runId = await _runId;
          // Closing twice records one end.
          if (info(name).done) return;
          await append(runId, name, [], true);
        });
      },

      async list(runId: string) {
        return db
          .all<{ name: string }>(
            'SELECT DISTINCT name FROM stream_chunks WHERE run_id = ? ORDER BY name',
            runId
          )
          .map((row) => row.name);
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
        // Data chunks are numbered from index 1 with no gaps, so data index
        // i is row idx i + 1.
        const rows = rowsAfter(name, startIndex, limit + 1);
        const data: { index: number; data: Uint8Array }[] = [];
        let done = false;
        let hasMore = false;
        for (const row of rows) {
          if (row.eof) {
            done = true;
            break;
          }
          if (data.length === limit) {
            hasMore = true;
            break;
          }
          data.push({ index: row.idx - 1, data: row.data ?? new Uint8Array() });
        }
        // Read to the end of a finished stream (or past it, or a purged
        // stream, whose end sits at index 0).
        if (!done && !hasMore) done = info(name).done;
        return {
          data,
          cursor: hasMore
            ? Buffer.from(
                JSON.stringify({ i: startIndex + data.length })
              ).toString('base64')
            : null,
          hasMore,
          done,
        };
      },

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        const { count, done } = info(name);
        return { tailIndex: count - 1, done };
      },

      async get(_runId: string, name: string, startIndex = 0) {
        let teardown = () => {};
        let closed = false;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            let resolvedStart = startIndex;
            if (typeof startIndex === 'number' && startIndex < 0) {
              resolvedStart = Math.max(0, info(name).count + startIndex);
            }
            // The last row index delivered (or skipped).
            let lastIdx = resolvedStart;
            let reading = false;
            let failures = 0;
            let timer: ReturnType<typeof setInterval> | null = null;
            const key = signalKey(db, name);

            const finish = () => {
              if (closed) return;
              closed = true;
              teardown();
              try {
                controller.close();
              } catch {
                // Already closed or cancelled.
              }
            };

            const drain = () => {
              if (closed || reading) return;
              reading = true;
              try {
                for (const row of rowsAfter(name, lastIdx)) {
                  lastIdx = row.idx;
                  if (row.eof) {
                    finish();
                    return;
                  }
                  if (row.data && row.data.byteLength > 0) {
                    controller.enqueue(row.data);
                  }
                }
                failures = 0;
                // Ended below the read position: started past the tail of a
                // finished stream, or a purged one (its end sits at index 0).
                // One seek, not a scan of the stream: an idle reader at the
                // tail of a long stream costs the same as at a short one.
                const last = lastRow(name);
                if (last?.eof && last.idx <= lastIdx) finish();
              } catch (error) {
                // A transient read failure (the database busy with another
                // process's recovery, say): the next poll reads from the
                // same position. Repeated failures end the stream.
                failures++;
                if (!closed && failures >= MAX_CONSECUTIVE_READ_FAILURES) {
                  closed = true;
                  teardown();
                  controller.error(error);
                }
              } finally {
                reading = false;
              }
            };

            teardown = () => {
              signals.emitter.off(key, drain);
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
            };

            signals.emitter.on(key, drain);
            drain();
            if (!closed) {
              timer = setInterval(drain, POLL_INTERVAL_MS);
            }
          },
          cancel() {
            closed = true;
            teardown();
          },
        });
      },
    },
  };
}
