import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { Client, type Pool } from 'pg';
import { monotonicFactory } from 'ulid';
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

  const notifyStream = async (payload: string) => {
    await pool.query('SELECT pg_notify($1, $2)', [STREAM_TOPIC, payload]);
  };

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

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        runId,
        chunkData: toBuffer(chunk),
        eof: false,
      });
      await notifyStream(
        JSON.stringify(
          StreamPublishMessage.encode({
            chunkId,
            streamId: name,
          })
        )
      );
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ) {
      if (chunks.length === 0) return;

      // Generate all chunk IDs up front to preserve ordering
      const chunkIds = chunks.map(() => genChunkId());

      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      // Batch insert all chunks in a single query
      await drizzle.insert(streams).values(
        chunks.map((chunk, i) => ({
          chunkId: chunkIds[i],
          streamId: name,
          runId,
          chunkData: toBuffer(chunk),
          eof: false,
        }))
      );

      // Notify for each chunk (could be batched in future if needed)
      for (const chunkId of chunkIds) {
        await notifyStream(
          JSON.stringify(
            StreamPublishMessage.encode({
              chunkId,
              streamId: name,
            })
          )
        );
      }
    },
    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        runId,
        chunkData: Buffer.from([]),
        eof: true,
      });
      await notifyStream(
        JSON.stringify(
          StreamPublishMessage.encode({
            streamId: name,
            chunkId,
          })
        )
      );
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
