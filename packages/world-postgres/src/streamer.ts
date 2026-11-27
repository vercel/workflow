import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Client, type Pool } from 'pg';
import { incrementBase32, monotonicFactory, TIME_LEN } from 'ulid';
import * as z from 'zod';
import { type Drizzle, Schema } from './drizzle/index.js';
import { Mutex } from './util.js';

const StreamPublishMessage = z.object({
  streamId: z.string(),
  chunkId: z.templateLiteral(['chnk_', z.string()]),
});

interface StreamChunkEvent {
  id: `chnk_${string}`;
  data: Uint8Array;
  eof: boolean;
}

class Rc<T extends { drop(): void }> {
  private refCount = 0;
  constructor(private resource: T) {}
  acquire() {
    this.refCount++;
    return {
      ...this.resource,
      [Symbol.dispose]: () => {
        this.release();
      },
    };
  }
  release() {
    this.refCount--;
    if (this.refCount <= 0) {
      this.resource.drop();
    }
  }
}

/**
 * Class id of the transaction-scoped advisory lock that orders writes to one
 * stream (`pg_advisory_xact_lock(class, streamLockKey(stream_id))`). The class
 * keeps these locks apart from advisory locks other code takes on the same
 * database. Two streams whose names hash alike share a lock, which only
 * serializes their writes.
 */
const STREAM_LOCK_CLASS = 0x5753_7472;

/**
 * The second key of a stream's advisory lock: a 32-bit FNV-1a hash of its
 * name, as a signed `int4`. Every process derives the same key from a name.
 */
function streamLockKey(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * Attempts an append makes to land above the stream's highest id before it
 * inserts regardless (see `appendChunks`).
 */
const MAX_APPEND_ATTEMPTS = 3;

/**
 * Subscribe to a PostgreSQL NOTIFY channel using a dedicated client created
 * from the pool's connection options. `channel` must be a trusted identifier.
 */
export const listenChannel = async (
  pool: Pool,
  channel: string,
  onPayload: (payload: string) => Promise<void>
): Promise<{ close: () => Promise<void> }> => {
  const client = new Client(pool.options);

  try {
    await client.connect();
    await client.query(`LISTEN ${channel}`);
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }

  const onNotification = (msg: { payload?: string | undefined }) => {
    onPayload(msg.payload ?? '').catch(() => {});
  };

  client.on('notification', onNotification);

  return {
    close: async () => {
      client.removeListener('notification', onNotification);
      try {
        await client.query(`UNLISTEN ${channel}`);
      } finally {
        await client.end();
      }
    },
  };
};

export type PostgresStreamer = Streamer & {
  /** Unlisten from the LISTEN subscription and release resources. */
  close(): Promise<void>;
};

export function createStreamer(pool: Pool, drizzle: Drizzle): PostgresStreamer {
  const ulid = monotonicFactory();
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const { streams } = Schema;
  const genChunkId = () => `chnk_${ulid()}` as const;
  // Renders drizzle `sql` for a statement sent on a checked-out client.
  const dialect = new PgDialect();
  const mutexes = new Map<string, Rc<{ drop(): void; mutex: Mutex }>>();
  // One abort function per reader that has not yet reached a terminal state
  // (EOF, cancel, or initial-query failure). `close()` drains this set so a
  // streamer shutdown detaches every listener still registered on `events`
  // and settles readers that would otherwise wait forever: the LISTEN client
  // is gone, so no notification can ever wake them.
  const activeReaders = new Set<() => void>();
  let closed = false;
  const streamerClosedError = () =>
    new Error('Cannot read stream: the Postgres streamer has been closed');
  const getMutex = (key: string) => {
    let mutex = mutexes.get(key);
    if (!mutex) {
      mutex = new Rc({
        mutex: new Mutex(),
        drop: () => mutexes.delete(key),
      });
      mutexes.set(key, mutex);
    }
    return mutex.acquire();
  };

  const STREAM_TOPIC = 'workflow_event_chunk';

  const listenSubscription = listenChannel(pool, STREAM_TOPIC, async (msg) => {
    const parsed = StreamPublishMessage.parse(JSON.parse(msg));

    const key = `strm:${parsed.streamId}` as const;
    if (!events.listenerCount(key)) {
      return;
    }

    const resource = getMutex(key);
    await resource.mutex.andThen(async () => {
      const [value] = await drizzle
        .select({ eof: streams.eof, data: streams.chunkData })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, parsed.streamId),
            eq(streams.chunkId, parsed.chunkId)
          )
        )
        .limit(1);
      if (!value) return;
      const { data, eof } = value;
      events.emit(key, { id: parsed.chunkId, data, eof });
    });
  });

  const loadPersistedChunks = (name: string): Promise<StreamChunkEvent[]> =>
    drizzle
      .select({
        id: streams.chunkId,
        eof: streams.eof,
        data: streams.chunkData,
      })
      .from(streams)
      .where(and(eq(streams.streamId, name)))
      .orderBy(streams.chunkId);

  // The chunkId of the first EOF row, if any has been written. A producer
  // that retries a terminal write can append data and EOF rows after it;
  // `getStreamChunks`/`getStreamInfo` bound their queries by this so those
  // rows are ignored the same way `readFromStream()` ignores them.
  const findFirstEofChunkId = async (
    name: string
  ): Promise<`chnk_${string}` | null> => {
    const [row] = await drizzle
      .select({ chunkId: streams.chunkId })
      .from(streams)
      .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
      .orderBy(asc(streams.chunkId))
      .limit(1);
    return row?.chunkId ?? null;
  };

  // Helper to convert chunk to Buffer
  const toBuffer = (chunk: string | Uint8Array): Buffer =>
    !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;

  /**
   * Appends chunks to a stream, in one transaction.
   *
   * Chunk ids order a stream: `readFromStream()`, `getStreamChunks()` and
   * `getStreamInfo()` read it by id, and a live reader drops a notification
   * whose id is not above the last one it delivered. So a chunk must commit,
   * and its notification must arrive, after every chunk with a lower id. Ids
   * taken before the insert do not guarantee that once two writers share a
   * stream, whether two steps in one process or writers in processes with
   * their own id generator and clock: the write that took the lower id can
   * commit second, and a live reader then skips it while `getStreamChunks()`
   * still returns it.
   *
   * The transaction therefore takes a lock on the stream first, which it
   * holds until it commits, and inserts only if its first id is above the
   * stream's highest id. If not, it takes ids above that one and inserts
   * again; the lock keeps the highest id from moving in between. It sends the
   * notifications in the same transaction, and Postgres delivers them when
   * the transaction commits, in commit order. Under the lock, commit order is
   * id order.
   *
   * `test/stream-concurrent-writers.test.ts` covers the ordering.
   */
  const appendChunks = async (
    runId: string,
    name: string,
    chunks: { data: Buffer; eof: boolean }[]
  ): Promise<void> => {
    const client = await pool.connect();
    try {
      // One round trip: the lock key is two integers computed here, so the
      // stream name is never written into the SQL text.
      await client.query(
        `BEGIN ISOLATION LEVEL READ COMMITTED; SELECT pg_advisory_xact_lock(${STREAM_LOCK_CLASS}, ${streamLockKey(name)})`
      );
      let chunkIds = chunks.map(() => genChunkId());
      for (let attempt = 1; ; attempt++) {
        // A writer that does not take the lock (an earlier version of this
        // World) can still move the highest id between attempts. After a few
        // attempts, insert regardless rather than never.
        const checkHead = attempt <= MAX_APPEND_ATTEMPTS;
        const query = dialect.sqlToQuery(
          appendStatement(runId, name, chunks, chunkIds, { checkHead })
        );
        const { rows } = await client.query<{
          head: `chnk_${string}` | null;
          inserted: number;
        }>(query.sql, query.params);
        const [{ head, inserted }] = rows;
        if (inserted > 0) break;
        if (checkHead && head !== null && head >= chunkIds[0]) {
          chunkIds = chunkIdsAfter(head, chunkIds.length);
          continue;
        }
        break;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  /**
   * The statement `appendChunks` runs under the stream lock: insert the
   * chunks (if `checkHead`, only when the first id is above the stream's
   * highest), notify each inserted chunk in id order, and return the highest
   * id it saw and how many chunks it inserted.
   */
  const appendStatement = (
    runId: string,
    name: string,
    chunks: { data: Buffer; eof: boolean }[],
    chunkIds: `chnk_${string}`[],
    { checkHead }: { checkHead: boolean }
  ) => {
    const rows = sql.join(
      chunks.map(
        (chunk, i) =>
          sql`(${chunkIds[i]}, ${name}, ${runId}, ${chunk.data}::bytea, ${chunk.eof}::boolean)`
      ),
      sql`, `
    );
    const aboveHead = checkHead
      ? sql`COALESCE(${chunkIds[0]} > (SELECT id FROM head), true)`
      : sql`true`;
    return sql`
      WITH head AS (
        SELECT max(id) AS id FROM ${streams} WHERE stream_id = ${name}
      ),
      ins AS (
        INSERT INTO ${streams} (id, stream_id, run_id, data, eof)
        SELECT v.id, v.stream_id, v.run_id, v.data, v.eof
        FROM (VALUES ${rows}) AS v (id, stream_id, run_id, data, eof)
        WHERE ${aboveHead}
        RETURNING id
      ),
      notified AS (
        SELECT pg_notify(
          ${STREAM_TOPIC},
          json_build_object('streamId', ${name}::text, 'chunkId', s.id)::text
        )
        FROM (SELECT id FROM ins ORDER BY id) AS s
      )
      SELECT
        (SELECT id FROM head) AS head,
        (SELECT count(*) FROM notified)::int AS inserted`;
  };

  /**
   * `count` increasing chunk ids above `head`: fresh ones when this process's
   * clock is already past it, otherwise `head`'s timestamp with its random
   * part incremented, as a monotonic ULID generator does within one
   * millisecond.
   */
  const chunkIdsAfter = (
    head: `chnk_${string}`,
    count: number
  ): `chnk_${string}`[] => {
    const fresh = Array.from({ length: count }, () => genChunkId());
    if (fresh[0] > head) return fresh;
    const ulid = head.slice('chnk_'.length);
    const time = ulid.slice(0, TIME_LEN);
    let random = ulid.slice(TIME_LEN);
    return Array.from({ length: count }, () => {
      random = incrementBase32(random);
      return `chnk_${time}${random}` as const;
    });
  };

  /**
   * Writes to one stream from this World run one at a time, in call order,
   * so they also commit in call order. Each write still takes the stream
   * lock, which orders it against writers in other processes.
   */
  const writeQueues = new Map<string, Promise<void>>();
  const queueStreamWrite = <T>(
    name: string,
    task: () => Promise<T>
  ): Promise<T> => {
    const previous = writeQueues.get(name) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => {},
      () => {}
    );
    writeQueues.set(name, tail);
    void tail.then(() => {
      if (writeQueues.get(name) === tail) writeQueues.delete(name);
    });
    return run;
  };

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      await queueStreamWrite(name, async () => {
        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;
        await appendChunks(runId, name, [
          { data: toBuffer(chunk), eof: false },
        ]);
      });
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ) {
      if (chunks.length === 0) return;
      await queueStreamWrite(name, async () => {
        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;
        // One statement, so the group commits together and in order.
        await appendChunks(
          runId,
          name,
          chunks.map((chunk) => ({ data: toBuffer(chunk), eof: false }))
        );
      });
    },

    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      await queueStreamWrite(name, async () => {
        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;
        await appendChunks(runId, name, [{ data: Buffer.from([]), eof: true }]);
      });
    },
    async getStreamChunks(
      name: string,
      _runId: string,
      options?: GetChunksOptions
    ): Promise<StreamChunksResponse> {
      const limit = options?.limit ?? 100;

      // Decode cursor to get the last seen chunkId
      let cursorChunkId: string | null = null;
      if (options?.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(options.cursor, 'base64').toString('utf-8')
          );
          cursorChunkId = decoded.c;
        } catch {
          // Invalid cursor, start from beginning
        }
      }

      // A producer that retries a terminal write can append data and EOF
      // rows after the first EOF; bound the page by it so a retried write
      // does not surface as (or inflate the count of) live data.
      const firstEofChunkId = await findFirstEofChunkId(name);

      // Fetch only data rows (exclude EOF) with limit + 1 to detect hasMore.
      // Filtering EOF here avoids the edge case where an EOF row sorting
      // mid-batch (e.g. due to clock skew) silently drops data rows.
      const rows = await drizzle
        .select({
          chunkId: streams.chunkId,
          data: streams.chunkData,
        })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, name),
            eq(streams.eof, false),
            ...(firstEofChunkId ? [lt(streams.chunkId, firstEofChunkId)] : []),
            ...(cursorChunkId
              ? [gt(streams.chunkId, cursorChunkId as `chnk_${string}`)]
              : [])
          )
        )
        .orderBy(asc(streams.chunkId))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const streamDone = firstEofChunkId !== null;

      // Build the cursor index: we need a running index across pages.
      // Decode the current start index from the cursor.
      let baseIndex = 0;
      if (options?.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(options.cursor, 'base64').toString('utf-8')
          );
          if (typeof decoded.i === 'number') {
            baseIndex = decoded.i;
          }
        } catch {
          // Invalid cursor
        }
      }

      const chunks = pageRows.map((row, i) => ({
        index: baseIndex + i,
        data: new Uint8Array(row.data),
      }));

      const nextCursor =
        hasMore && pageRows.length > 0
          ? Buffer.from(
              JSON.stringify({
                c: pageRows[pageRows.length - 1].chunkId,
                i: baseIndex + pageRows.length,
              })
            ).toString('base64')
          : null;

      return {
        data: chunks,
        cursor: nextCursor,
        hasMore,
        done: streamDone,
      };
    },

    async getStreamInfo(
      name: string,
      _runId: string
    ): Promise<StreamInfoResponse> {
      // A producer that retries a terminal write can append data and EOF
      // rows after the first EOF; bound the count by it so those rows
      // don't inflate tailIndex.
      const firstEofChunkId = await findFirstEofChunkId(name);

      // Use COUNT(*) instead of fetching all rows into memory
      const [countResult] = await drizzle
        .select({ count: sql<number>`count(*)` })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, name),
            eq(streams.eof, false),
            ...(firstEofChunkId ? [lt(streams.chunkId, firstEofChunkId)] : [])
          )
        );

      const dataCount = Number(countResult?.count ?? 0);

      return {
        tailIndex: dataCount - 1,
        done: firstEofChunkId !== null,
      };
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      if (closed) {
        throw streamerClosedError();
      }

      const cleanups: (() => void)[] = [];
      let cleanedUp = false;
      // Idempotent: reachable from EOF, cancel(), initial-query failure,
      // and streamer close(), and more than one of those can fire for the
      // same reader (e.g. cancel() while the initial query is in flight).
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        activeReaders.delete(abort);
        cleanups.forEach((fn) => void fn());
      };
      // `start()` runs synchronously inside the ReadableStream constructor
      // up to its first `await`, so `controller` is assigned before
      // `readFromStream()` returns and before `abort` can be invoked from
      // `close()`.
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => {
        cleanup();
        controller.error(streamerClosedError());
      };
      activeReaders.add(abort);

      return new ReadableStream<Uint8Array>({
        async start(ctrl) {
          controller = ctrl;
          // an empty string is always < than any string,
          // so `'' < ulid()` and `ulid() < ulid()` (maintaining order)
          let lastChunkId = '';
          let offset = startIndex ?? 0;
          let buffer = [] as StreamChunkEvent[] | null;

          function enqueue(msg: {
            id: string;
            data: Uint8Array;
            eof: boolean;
          }) {
            if (cleanedUp) {
              // The reader was cancelled or the streamer closed while the
              // initial query was in flight; the controller is no longer
              // writable. Also true once the first EOF has been delivered
              // (cleanup() runs below): a producer that retries a
              // terminal write (lost ACK, overlapping attempts) can append
              // data and EOF rows after it, and enqueuing those on the
              // already-closed controller would throw out of `start()`,
              // discarding every chunk still queued.
              return;
            }

            if (lastChunkId >= msg.id) {
              // already sent or out of order
              return;
            }
            lastChunkId = msg.id;

            // The EOF marker is not a data chunk (`getStreamInfo`'s tailIndex
            // excludes it), so it never counts toward `offset`: a start
            // index at or past the data count must still close the
            // stream rather than consume the marker and then hang, or
            // surface rows written after it.
            if (offset > 0 && !msg.eof) {
              offset--;
              return;
            }

            if (msg.data.byteLength) {
              controller.enqueue(new Uint8Array(msg.data));
            }
            if (msg.eof) {
              cleanup();
              controller.close();
            }
          }

          function onData(data: StreamChunkEvent) {
            if (buffer) {
              buffer.push(data);
              return;
            }
            enqueue(data);
          }
          events.on(`strm:${name}`, onData);
          cleanups.push(() => {
            events.off(`strm:${name}`, onData);
          });

          // A rejection here fails the stream; detach the listener that was
          // registered above so a failing stream does not leak on each read.
          const chunks = await loadPersistedChunks(name).catch((err) => {
            cleanup();
            throw err;
          });

          // Resolve negative offset relative to the data chunk count: the
          // rows before the first EOF marker. Rows after it (a retried
          // terminal write) are ignored by `enqueue`, so they must not
          // count here either.
          if (typeof offset === 'number' && offset < 0) {
            const firstEof = chunks.findIndex((chunk) => chunk.eof);
            const dataCount = firstEof === -1 ? chunks.length : firstEof;
            offset = Math.max(0, dataCount + offset);
          }

          for (const chunk of [...chunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }
          buffer = null;
        },
        cancel() {
          cleanup();
        },
      });
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      // Query distinct stream IDs associated with the runId
      const results = await drizzle
        .selectDistinct({ streamId: streams.streamId })
        .from(streams)
        .where(eq(streams.runId, runId));

      return results.map((r) => r.streamId);
    },

    async close() {
      closed = true;
      for (const abort of [...activeReaders]) {
        abort();
      }
      const sub = await listenSubscription.catch(() => undefined);
      if (sub) await sub.close();
    },
  };
}
