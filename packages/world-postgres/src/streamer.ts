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
import { createPagedStream } from './paged-stream.js';

const StreamPublishMessage = z.compile(
  z.object({
    streamId: z.string(),
    chunkId: z.templateLiteral(['chnk_', z.string()]),
  })
);

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
    [key: `strm:${string}`]: [];
  }>();
  const { streams } = Schema;
  const genChunkId = () => `chnk_${ulid()}` as const;
  // One abort function per reader that has not yet reached a terminal state
  // (EOF, cancel, or initial-query failure). `close()` drains this set so a
  // streamer shutdown detaches every listener still registered on `events`
  // and settles readers that would otherwise wait forever: the LISTEN client
  // is gone, so no notification can ever wake them.
  const activeReaders = new Set<() => void>();
  let closed = false;
  const streamerClosedError = () =>
    new Error('Cannot read stream: the Postgres streamer has been closed');

  const STREAM_TOPIC = 'workflow_event_chunk';

  // A notification carries no rows: it wakes the readers of its stream, and
  // each reader queries the persisted rows from its own keyset cursor.
  const listenSubscription = listenChannel(pool, STREAM_TOPIC, async (msg) => {
    const { streamId } = StreamPublishMessage.parse(JSON.parse(msg));
    events.emit(`strm:${streamId}`);
  });

  const notifyStream = async (payload: string) => {
    await pool.query('SELECT pg_notify($1, $2)', [STREAM_TOPIC, payload]);
  };

  // The chunkId of the first EOF row, if any has been written. A producer
  // that retries a terminal write can append data and EOF rows after it;
  // `getChunks`/`getInfo` bound their queries by this so those rows are
  // ignored the same way `streams.get()` ignores them.
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

  // Data rows before the first EOF: the rows a `streams.get()` start index
  // counts. A close() may commit between the EOF lookup and the count, so a
  // stream found open is looked up once more and recounted if it closed.
  const countDataRows = async (name: string) => {
    const count = async (firstEof: `chnk_${string}` | null) => {
      const [row] = await drizzle
        .select({ count: sql<number>`count(*)` })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, name),
            eq(streams.eof, false),
            ...(firstEof ? [lt(streams.chunkId, firstEof)] : [])
          )
        );
      return Number(row?.count ?? 0);
    };
    const firstEof = await findFirstEofChunkId(name);
    if (firstEof !== null) return { count: await count(firstEof), firstEof };
    const openCount = await count(null);
    const closedSince = await findFirstEofChunkId(name);
    return closedSince === null
      ? { count: openCount, firstEof: null }
      : { count: await count(closedSince), firstEof: closedSince };
  };

  // The id of the data row at zero-based `position` before the first EOF.
  const findDataRowAt = async (
    name: string,
    firstEof: `chnk_${string}` | null,
    position: number
  ): Promise<`chnk_${string}`> => {
    const [row] = await drizzle
      .select({ chunkId: streams.chunkId })
      .from(streams)
      .where(
        and(
          eq(streams.streamId, name),
          eq(streams.eof, false),
          ...(firstEof ? [lt(streams.chunkId, firstEof)] : [])
        )
      )
      .orderBy(asc(streams.chunkId))
      .offset(position)
      .limit(1);
    if (!row) {
      throw new Error('Stream rows changed while positioning the start index');
    }
    return row.chunkId;
  };

  // Helper to convert chunk to Buffer
  const toBuffer = (chunk: string | Uint8Array): Buffer =>
    !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;

  return {
    streams: {
      async write(
        _runId: string | Promise<string>,
        name: string,
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

      async writeMulti(
        _runId: string | Promise<string>,
        name: string,
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

      async close(
        _runId: string | Promise<string>,
        name: string
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

      async getChunks(
        _runId: string,
        name: string,
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
              ...(firstEofChunkId
                ? [lt(streams.chunkId, firstEofChunkId)]
                : []),
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

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
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

      async get(
        _runId: string,
        name: string,
        startIndex?: number
      ): Promise<ReadableStream<Uint8Array>> {
        // History is read in keyset pages of persisted rows, pulled as the
        // consumer reads. NOTIFY only wakes a reader that has caught up, so
        // the stream never sits in memory as a whole and a row seen by both a
        // query and a notification is delivered (or skipped) exactly once.
        // The first EOF row closes the reader; rows a retried terminal write
        // appends after it are never read.
        return createPagedStream(
          {
            isClosed: () => closed,
            closedError: streamerClosedError,
            subscribe(wake) {
              events.on(`strm:${name}`, wake);
              return () => {
                events.off(`strm:${name}`, wake);
              };
            },
            registerAbort(abort) {
              activeReaders.add(abort);
              return () => {
                activeReaders.delete(abort);
              };
            },
            async prepareStart(index) {
              const { count, firstEof } = await countDataRows(name);
              const offset = index < 0 ? Math.max(0, count + index) : index;
              const skip = Math.min(offset, count);
              if (skip === 0) {
                return { cursor: undefined, remainingOffset: offset };
              }
              return {
                cursor: await findDataRowAt(name, firstEof, skip - 1),
                remainingOffset: offset - skip,
              };
            },
            loadPage: (cursor, limit) =>
              drizzle
                .select({
                  id: streams.chunkId,
                  eof: streams.eof,
                  data: streams.chunkData,
                })
                .from(streams)
                .where(
                  and(
                    eq(streams.streamId, name),
                    ...(cursor === undefined
                      ? []
                      : [gt(streams.chunkId, cursor)])
                  )
                )
                .orderBy(asc(streams.chunkId))
                .limit(limit),
          },
          startIndex ?? 0
        );
      },

      async list(runId: string): Promise<string[]> {
        // Query distinct stream IDs associated with the runId
        const results = await drizzle
          .selectDistinct({ streamId: streams.streamId })
          .from(streams)
          .where(eq(streams.runId, runId));

        return results.map((r) => r.streamId);
      },
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
