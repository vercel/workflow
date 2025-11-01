import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { RedisClientType, RedisScripts, RedisFunctions, RedisDefaultModules } from 'redis';

export function createStreamer(redis: RedisClientType<RedisDefaultModules, RedisFunctions, RedisScripts>): Streamer {
  const ulid = monotonicFactory();

  const genChunkId = () => `chnk_${ulid()}` as const;
  const keyForStream = (name: string) => `strm:${name}:stream`;

  return {
    async writeToStream(name, chunk) {
      const chunkId = genChunkId();
      const data = Buffer.isBuffer(chunk)
        ? chunk.toString('base64')
        : Buffer.from(chunk).toString('base64');
      await redis.xAdd(keyForStream(name), '*', {
        id: chunkId,
        eof: '0',
        data,
      });
    },
    async closeStream(name: string): Promise<void> {
      const chunkId = genChunkId();
      await redis.xAdd(keyForStream(name), '*', {
        id: chunkId,
        eof: '1',
        data: '',
      });
    },
    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      const streamKey = keyForStream(name);

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let eofSeen = false;
          let lastId = '0-0';

          // If caller specified a start index, fast-forward using XRANGE COUNT
          if (typeof startIndex === 'number' && startIndex > 0) {
            const bootstrap = await redis.xRange(streamKey, '-', '+', {
              COUNT: startIndex,
            });
            if (bootstrap.length > 0) {
              lastId = bootstrap[bootstrap.length - 1].id;
            }
          }

          while (!eofSeen) {
            const res = await redis.xRead([{ key: streamKey, id: lastId }], {
              BLOCK: 15000,
              COUNT: 100,
            });
            if (!res) {
              // timeout; continue waiting
              continue;
            }
            for (const stream of res) {
              for (const msg of stream.messages) {
                lastId = msg.id;
                const fields = msg.message as Record<string, string>;
                const data = fields.data ?? '';
                const eof = fields.eof === '1';
                if (data) {
                  controller.enqueue(Buffer.from(data, 'base64'));
                }
                if (eof) {
                  eofSeen = true;
                  controller.close();
                  break;
                }
              }
              if (eofSeen) break;
            }
          }
        },
        async cancel() {
          // Reader will be GC'd; best-effort cleanup done by connection close on process exit
        },
      });
    },
  };
}
