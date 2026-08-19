import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
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
 * from the pool's connection options. `channel` must be a trusted identifier
 * (interpolated into the LISTEN statement; `pg` does not parameterise
 * identifiers).
 *
 * The dedicated `Client` is long-lived and will eventually be dropped by the
 * server (idle TCP timeout, pgbouncer rotation, k8s CNI eviction). Without
 * reconnect handling, a process running for more than a few hours stops
 * receiving notifications and only a restart restores delivery
 * (cf. brianc/node-postgres#967).
 *
 * This implementation wraps the client in a reconnect loop with bounded
 * exponential backoff (250 ms → 30 s cap). The initial connect must succeed
 * (callers expect a live subscription before the promise resolves);
 * subsequent reconnects are best-effort. Notifications fired while the
 * dedicated client is reconnecting are lost on the wire — the polling
 * fallback in {@link createStreamer}'s `streams.get` re-queries chunks from
 * the database on its periodic tick, so end-to-end delivery stays correct
 * even across LISTEN gaps.
 */
export const listenChannel = async (
  pool: Pool,
  channel: string,
  onPayload: (payload: string) => Promise<void>
): Promise<{ close: () => Promise<void> }> => {
  let client: Client | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const onNotification = (msg: { payload?: string | undefined }) => {
    onPayload(msg.payload ?? '').catch(() => {});
  };

  const detach = (c: Client) => {
    try {
      c.removeListener('notification', onNotification);
    } catch {
      // listener may already be detached
    }
    c.end().catch(() => {});
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(30_000, 250 * 2 ** reconnectAttempt);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      connect().catch((err) => {
        console.warn(
          '[world-postgres listenChannel] reconnect failed',
          (err as Error)?.message ?? err
        );
        scheduleReconnect();
      });
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    const next = new Client(pool.options);
    next.on('error', (err) => {
      console.warn(
        '[world-postgres listenChannel] client error',
        (err as Error)?.message ?? err
      );
      if (client === next) client = null;
      detach(next);
      scheduleReconnect();
    });
    next.on('end', () => {
      if (closed) return;
      if (client === next) client = null;
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${channel}`);
    } catch (err) {
      await next.end().catch(() => {});
      throw err;
    }
    // `close()` may have been called while we were awaiting connect/LISTEN.
    // Without this guard the freshly-connected client would attach a
    // notification listener and survive past `close()` — a slow reconnect
    // could outlive the subscription it's meant to back.
    if (closed) {
      await next.end().catch(() => {});
      return;
    }
    next.on('notification', onNotification);
    client = next;
    reconnectAttempt = 0;
  };

  await connect();

  return {
    close: async () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const c = client;
      client = null;
      if (!c) return;
      try {
        c.removeListener('notification', onNotification);
      } catch {
        // listener may already be detached
      }
      try {
        await c.query(`UNLISTEN ${channel}`);
      } finally {
        await c.end().catch(() => {});
      }
    },
  };
};

export type PostgresStreamer = Streamer & {
  /** Unlisten from the LISTEN subscription and release resources. */
  close(): Promise<void>;
};

export type CreateStreamerOptions = {
  /**
   * How often (ms) `streams.get` re-queries the `streams` table for chunks
   * past `lastChunkId` as a safety net for notifications dropped while the
   * LISTEN client was reconnecting. The poll dedupes against in-band
   * notifications via the existing `enqueue` ordering check, so it is safe
   * to run alongside `LISTEN/NOTIFY`.
   *
   * Lower values reduce recovery latency after a LISTEN disconnect; higher
   * values reduce baseline DB load (one extra `SELECT` per active reader per
   * tick). Set to `0` to disable polling — only do this if you know the
   * LISTEN connection cannot be interrupted (e.g. tests). Default: 5000.
   */
  pollIntervalMs?: number;
};

export function createStreamer(
  pool: Pool,
  drizzle: Drizzle,
  options: CreateStreamerOptions = {}
): PostgresStreamer {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const ulid = monotonicFactory();
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const { streams } = Schema;
  const genChunkId = () => `chnk_${ulid()}` as const;
  const mutexes = new Map<string, Rc<{ drop(): void; mutex: Mutex }>>();
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
              ...(cursorChunkId
                ? [gt(streams.chunkId, cursorChunkId as `chnk_${string}`)]
                : [])
            )
          )
          .orderBy(asc(streams.chunkId))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);

        // Check if stream is complete via a separate EOF query
        let streamDone = false;
        const [eofRow] = await drizzle
          .select({ eof: streams.eof })
          .from(streams)
          .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
          .limit(1);
        if (eofRow) {
          streamDone = true;
        }

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
        // Use COUNT(*) instead of fetching all rows into memory
        const [countResult] = await drizzle
          .select({ count: sql<number>`count(*)` })
          .from(streams)
          .where(and(eq(streams.streamId, name), eq(streams.eof, false)));

        const dataCount = Number(countResult?.count ?? 0);

        // Check for EOF
        const [eofRow] = await drizzle
          .select({ eof: streams.eof })
          .from(streams)
          .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
          .limit(1);

        return {
          tailIndex: dataCount - 1,
          done: !!eofRow,
        };
      },

      async get(
        _runId: string,
        name: string,
        startIndex?: number
      ): Promise<ReadableStream<Uint8Array>> {
        const cleanups: (() => void)[] = [];

        return new ReadableStream<Uint8Array>({
          async start(controller) {
            // an empty string is always < than any string,
            // so `'' < ulid()` and `ulid() < ulid()` (maintaining order)
            let lastChunkId = '';
            let offset = startIndex ?? 0;
            let buffer = [] as StreamChunkEvent[] | null;
            let polling = false;
            let closed = false;
            let pollTimer: ReturnType<typeof setInterval> | null = null;

            function onData(data: StreamChunkEvent) {
              if (buffer) {
                buffer.push(data);
                return;
              }
              enqueue(data);
            }

            // Idempotent teardown for the reader: detach the EventEmitter
            // listener and clear the polling timer. Called both from
            // `cancel()` (consumer aborts) and from `enqueue` on EOF
            // (natural completion) so the polling timer doesn't keep
            // ticking indefinitely after the controller has closed.
            const stop = () => {
              closed = true;
              if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
              }
              events.off(`strm:${name}`, onData);
            };

            function enqueue(msg: {
              id: string;
              data: Uint8Array;
              eof: boolean;
            }) {
              if (closed || lastChunkId >= msg.id) {
                // already sent, out of order, or stream torn down
                return;
              }

              // Advance the high-water mark before any early return. The
              // polling fallback re-queries `chunk_id > lastChunkId` and
              // would otherwise re-enqueue chunks we intentionally skipped
              // for `startIndex`, double-decrementing `offset` and
              // eventually mis-delivering them.
              lastChunkId = msg.id;

              if (offset > 0) {
                offset--;
                return;
              }

              if (msg.data.byteLength) {
                controller.enqueue(new Uint8Array(msg.data));
              }
              if (msg.eof) {
                controller.close();
                stop();
              }
            }

            events.on(`strm:${name}`, onData);
            cleanups.push(stop);

            const chunks = await drizzle
              .select({
                id: streams.chunkId,
                eof: streams.eof,
                data: streams.chunkData,
              })
              .from(streams)
              .where(and(eq(streams.streamId, name)))
              .orderBy(streams.chunkId);

            // Resolve negative offset relative to the data chunk count
            // (excluding the trailing EOF marker, if present)
            if (typeof offset === 'number' && offset < 0) {
              const dataCount =
                chunks.length > 0 && chunks[chunks.length - 1].eof
                  ? chunks.length - 1
                  : chunks.length;
              offset = Math.max(0, dataCount + offset);
            }

            for (const chunk of [...chunks, ...(buffer ?? [])]) {
              enqueue(chunk);
            }
            buffer = null;

            // Polling fallback. NOTIFY is the fast path, but events are
            // silently dropped while the dedicated LISTEN client is
            // reconnecting. A light periodic re-query of chunks past
            // `lastChunkId` is the always-on safety net: every
            // `pollIntervalMs` it pulls any chunks the EventEmitter missed,
            // deduped by the `enqueue` ordering check. The timer is cleared
            // by `stop()` on EOF or cancel; transient query failures are
            // logged so the next tick can retry.
            const runPoll = async () => {
              const fresh = await drizzle
                .select({
                  id: streams.chunkId,
                  eof: streams.eof,
                  data: streams.chunkData,
                })
                .from(streams)
                .where(
                  and(
                    eq(streams.streamId, name),
                    gt(streams.chunkId, lastChunkId as `chnk_${string}`)
                  )
                )
                .orderBy(streams.chunkId);
              for (const chunk of fresh) {
                if (closed) return;
                enqueue(chunk);
              }
            };

            const tick = async () => {
              if (polling || closed) return;
              polling = true;
              try {
                await runPoll();
              } catch (err) {
                // Best-effort. Logs only; the next tick retries.
                console.warn(
                  '[world-postgres streams.get] poll failed',
                  (err as Error)?.message ?? err
                );
              } finally {
                polling = false;
              }
            };

            // Initial chunks may have already delivered EOF; in that case
            // `stop()` cleared the flag and we don't start polling at all.
            if (!closed && pollIntervalMs > 0) {
              pollTimer = setInterval(tick, pollIntervalMs);
            }
          },
          cancel() {
            cleanups.forEach((fn) => void fn());
          },
        });
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
      const sub = await listenSubscription.catch(() => undefined);
      if (sub) await sub.close();
    },
  };
}
