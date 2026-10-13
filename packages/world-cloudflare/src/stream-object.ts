/**
 * Stream storage. `stream:<runId>:<name>` holds one stream's chunks;
 * `streams:<runId>` holds the names of a run's streams.
 *
 * Kept out of the run object so heavy stream traffic never queues behind the
 * workflow's own events.
 */
import { DurableObject } from 'cloudflare:workers';
import { serve } from './rpc.js';

interface StreamMeta {
  count: number;
  closed: boolean;
}

const chunkKey = (index: number) => `c:${String(index).padStart(12, '0')}`;

export class StreamObject extends DurableObject {
  #meta(): StreamMeta {
    return (
      this.ctx.storage.kv.get<StreamMeta>('meta') ?? { count: 0, closed: false }
    );
  }

  async append(chunks: Uint8Array[]) {
    return serve(() => {
      const meta = this.#meta();
      if (meta.closed) throw new Error('Cannot write to a closed stream');
      for (const chunk of chunks) {
        this.ctx.storage.kv.put(chunkKey(meta.count++), chunk);
      }
      this.ctx.storage.kv.put('meta', meta);
    });
  }

  async close() {
    return serve(() => {
      this.ctx.storage.kv.put('meta', { ...this.#meta(), closed: true });
    });
  }

  async chunks(options: { cursor?: string; limit?: number }) {
    return serve(() => {
      const meta = this.#meta();
      const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
      const limit = Math.min(options.limit ?? 100, 1000);
      const data: { index: number; data: Uint8Array }[] = [];
      for (const [key, value] of this.ctx.storage.kv.list<Uint8Array>({
        start: chunkKey(start),
        end: chunkKey(start + limit),
        prefix: 'c:',
      })) {
        data.push({ index: Number.parseInt(key.slice(2), 10), data: value });
      }
      const end = start + data.length;
      const hasMore = end < meta.count;
      return {
        data,
        cursor: hasMore ? String(end) : null,
        hasMore,
        done: meta.closed && !hasMore,
      };
    });
  }

  async info() {
    return serve(() => {
      const meta = this.#meta();
      return { tailIndex: meta.count - 1, done: meta.closed };
    });
  }

  async register(name: string) {
    return serve(() => {
      this.ctx.storage.kv.put(`n:${name}`, true);
    });
  }

  async names() {
    return serve(() =>
      [...this.ctx.storage.kv.list({ prefix: 'n:' })].map(([key]) =>
        key.slice(2)
      )
    );
  }
}
