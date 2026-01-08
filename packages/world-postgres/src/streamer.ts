import { EventEmitter } from 'node:events';
import type { Streamer } from '@workflow/world';
import { and, eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
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

export function createStreamer(postgres: Sql, drizzle: Drizzle): Streamer {
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
  postgres.listen(STREAM_TOPIC, async (msg) => {
    const parsed = await Promise.resolve(msg)
      .then(JSON.parse)
      .then(StreamPublishMessage.parse);

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
        chunkData: !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk,
        eof: false,
      });
      postgres.notify(
        STREAM_TOPIC,
        JSON.stringify(
          StreamPublishMessage.encode({
            chunkId,
            streamId: name,
          })
        )
      );
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
      postgres.notify(
        'workflow_event_chunk',
        JSON.stringify(
          StreamPublishMessage.encode({
            streamId: name,
            chunkId,
          })
        )
      );
    },
    async readFromStream(
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

          function enqueue(msg: {
            id: string;
            data: Uint8Array;
            eof: boolean;
          }) {
            if (lastChunkId >= msg.id) {
              // already sent or out of order
              return;
            }

            if (offset > 0) {
              offset--;
              return;
            }

            if (msg.data.byteLength) {
              controller.enqueue(new Uint8Array(msg.data));
            }
            if (msg.eof) {
              controller.close();
            }
            lastChunkId = msg.id;
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

          const chunks = await drizzle
            .select({
              id: streams.chunkId,
              eof: streams.eof,
              data: streams.chunkData,
            })
            .from(streams)
            .where(and(eq(streams.streamId, name)))
            .orderBy(streams.chunkId);

          for (const chunk of [...chunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }
          buffer = null;
        },
        cancel() {
          cleanups.forEach((fn) => fn());
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
  };
}
