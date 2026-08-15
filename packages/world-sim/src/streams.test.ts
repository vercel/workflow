import { describe, expect, it } from 'vitest';
import { createSimStreamer } from './streams.js';

describe('sim keyed stream append', () => {
  it('converges concurrent retries on one canonical physical chunk', async () => {
    const streamer = createSimStreamer();
    const request = {
      idempotencyKey: 'eve-public-event/v1/run/step/0',
      semanticDigest: 'digest-a',
      chunk: new Uint8Array([4, 2]),
    };
    const [first, retry] = await Promise.all([
      streamer.streams.appendKeyed!('run', 'stream', request),
      streamer.streams.appendKeyed!('run', 'stream', request),
    ]);

    expect([first.inserted, retry.inserted].filter(Boolean)).toHaveLength(1);
    expect(first.canonicalChunk).toEqual(new Uint8Array([4, 2]));
    expect(retry.canonicalChunk).toEqual(new Uint8Array([4, 2]));
    expect((await streamer.streams.getChunks('run', 'stream')).data).toEqual([
      { index: 0, data: new Uint8Array([4, 2]) },
    ]);
  });
});
