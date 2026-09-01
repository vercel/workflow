import { StreamExpiredError } from '@workflow/errors';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeMultiChunks, MAX_CHUNKS_PER_REQUEST } from './streamer.js';

// Every request-issuing test in this file observes the streamer through a
// stubbed `fetch`. The node:http path does not call `fetch`, so the flag is
// pinned off for all of them.
beforeEach(() => {
  vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('encodeMultiChunks', () => {
  /**
   * Helper to decode length-prefixed chunks back to verify encoding
   */
  function decodeMultiChunks(encoded: Uint8Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    const view = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength
    );
    let offset = 0;

    while (offset < encoded.length) {
      const length = view.getUint32(offset, false); // big-endian
      offset += 4;
      chunks.push(encoded.slice(offset, offset + length));
      offset += length;
    }

    return chunks;
  }

  it('should encode an empty array', () => {
    const result = encodeMultiChunks([]);
    expect(result.length).toBe(0);
  });

  it('should encode a single string chunk', () => {
    const result = encodeMultiChunks(['hello']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(1);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
  });

  it('should encode a single Uint8Array chunk', () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    const result = encodeMultiChunks([chunk]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(chunk);
  });

  it('should encode multiple string chunks', () => {
    const result = encodeMultiChunks(['hello', 'world', 'test']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
    expect(new TextDecoder().decode(decoded[1])).toBe('world');
    expect(new TextDecoder().decode(decoded[2])).toBe('test');
  });

  it('should encode multiple Uint8Array chunks', () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    const result = encodeMultiChunks(chunks);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toEqual(chunks[0]);
    expect(decoded[1]).toEqual(chunks[1]);
    expect(decoded[2]).toEqual(chunks[2]);
  });

  it('should encode mixed string and Uint8Array chunks', () => {
    const result = encodeMultiChunks([
      'hello',
      new Uint8Array([1, 2, 3]),
      'world',
    ]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
    expect(decoded[1]).toEqual(new Uint8Array([1, 2, 3]));
    expect(new TextDecoder().decode(decoded[2])).toBe('world');
  });

  it('should handle empty string chunks', () => {
    const result = encodeMultiChunks(['', 'hello', '']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(decoded[0].length).toBe(0);
    expect(new TextDecoder().decode(decoded[1])).toBe('hello');
    expect(decoded[2].length).toBe(0);
  });

  it('should handle empty Uint8Array chunks', () => {
    const result = encodeMultiChunks([
      new Uint8Array([]),
      new Uint8Array([1, 2]),
      new Uint8Array([]),
    ]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(decoded[0].length).toBe(0);
    expect(decoded[1]).toEqual(new Uint8Array([1, 2]));
    expect(decoded[2].length).toBe(0);
  });

  it('should correctly calculate total size with length prefixes', () => {
    // Each chunk has a 4-byte length prefix
    // 'hello' = 5 bytes, 'world' = 5 bytes
    // Total = 4 + 5 + 4 + 5 = 18 bytes
    const result = encodeMultiChunks(['hello', 'world']);
    expect(result.length).toBe(18);
  });

  it('should use big-endian encoding for length prefix', () => {
    const result = encodeMultiChunks(['hello']);
    const view = new DataView(
      result.buffer,
      result.byteOffset,
      result.byteLength
    );

    // 'hello' is 5 bytes, big-endian encoding of 5 is [0, 0, 0, 5]
    expect(view.getUint32(0, false)).toBe(5);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    expect(result[3]).toBe(5);
  });

  it('should handle large chunks', () => {
    // Create a 10KB chunk
    const largeChunk = new Uint8Array(10 * 1024);
    for (let i = 0; i < largeChunk.length; i++) {
      largeChunk[i] = i % 256;
    }

    const result = encodeMultiChunks([largeChunk]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(largeChunk);
  });

  it('should handle many small chunks', () => {
    const chunks = Array.from({ length: 100 }, (_, i) => `chunk${i}`);
    const result = encodeMultiChunks(chunks);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(100);
    decoded.forEach((chunk, i) => {
      expect(new TextDecoder().decode(chunk)).toBe(`chunk${i}`);
    });
  });

  it('should handle unicode strings correctly', () => {
    const result = encodeMultiChunks(['hello', '世界', '🚀']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
    expect(new TextDecoder().decode(decoded[1])).toBe('世界');
    expect(new TextDecoder().decode(decoded[2])).toBe('🚀');
  });
});

// vi.mock is hoisted by vitest, so it cannot be truly scoped to a
// describe block. Keeping it here (next to the tests that need it)
// makes the intent clear. The encodeMultiChunks tests above are pure
// functions and are unaffected.
vi.mock('./utils.js', () => ({
  getHttpConfig: vi.fn().mockResolvedValue({
    baseUrl: 'https://test.example.com',
    headers: new Headers(),
  }),
  makeRequest: vi.fn().mockResolvedValue({
    data: [],
    cursor: null,
    hasMore: false,
    done: true,
  }),
}));

describe('streams.get', () => {
  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the live stream from the v3 endpoint (error-on-timeout)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(new ReadableStream(), { status: 200 })
      );

    const streamer = await getStreamer();
    await streamer.streams.get('run-123', 'my-stream');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    // v3, not v2: the reconnecting reader relies on the server erroring the
    // body on a max-duration timeout rather than closing it cleanly.
    expect(url.pathname).toBe('/v3/runs/run-123/stream/my-stream');
  });

  it('reads chunk pages from the v3 endpoint', async () => {
    const { makeRequest } = await import('./utils.js');
    const streamer = await getStreamer();

    await streamer.streams.getChunks('run-123', 'my-stream', {
      limit: 500,
      cursor: 'next',
    });

    expect(makeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint:
          '/v3/runs/run-123/streams/my-stream/chunks?limit=500&cursor=next',
      })
    );
  });

  it('throws a typed terminal error with the retention details on 410', async () => {
    const expiredAt = '2026-08-10T14:40:00.000Z';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        {
          success: false,
          error: 'stream-expired',
          message: 'The stream reached its storage retention limit',
          details: {
            runId: 'wrun_test',
            streamId: 'stream-test',
            expiredAt,
          },
        },
        { status: 410 }
      )
    );

    const streamer = await getStreamer();
    const error = await streamer.streams
      .get('wrun_test', 'stream-test')
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StreamExpiredError);
    expect(error).toMatchObject({
      message: 'The stream reached its storage retention limit',
      runId: 'wrun_test',
      streamId: 'stream-test',
      expiredAt: new Date(expiredAt),
      status: 410,
      code: 'stream-expired',
    });
    const request = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = (request[1] as RequestInit).headers as Headers;
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('falls back safely for non-stream-expired errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        { error: 'run-expired', message: 'Run is unavailable' },
        { status: 410 }
      )
    );

    const streamer = await getStreamer();
    await expect(
      streamer.streams.get('wrun_test', 'stream-test')
    ).rejects.toThrow('Run is unavailable');
    await expect(
      streamer.streams.get('wrun_test', 'stream-test')
    ).rejects.not.toBeInstanceOf(StreamExpiredError);
  });

  it('passes startIndex as a query parameter on the v3 read', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(new ReadableStream(), { status: 200 })
      );

    const streamer = await getStreamer();
    await streamer.streams.get('run-123', 'my-stream', 5);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v3/runs/run-123/stream/my-stream');
    expect(url.searchParams.get('startIndex')).toBe('5');
  });
});

describe('streams.write error diagnostics', () => {
  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes endpoint and Vercel correlation headers in failed writes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('Internal Server Error\nrequest-token', {
          status: 500,
          headers: {
            'x-vercel-id': 'sfo1::abc',
            'x-vercel-error': 'FUNCTION_INVOCATION_FAILED',
          },
        })
    );

    const streamer = await getStreamer();

    await expect(
      streamer.streams.write('wrun_test', 'user', 'chunk')
    ).rejects.toThrow(
      'Stream write failed: HTTP 500 (PUT https://test.example.com/v2/runs/wrun_test/stream/user; x-vercel-id=sfo1::abc; x-vercel-error=FUNCTION_INVOCATION_FAILED): Internal Server Error\nrequest-token'
    );
  });
});

describe('writeMulti pagination', () => {
  /**
   * Decode length-prefixed multi-chunk body to count chunks per request.
   */
  function countChunksInBody(encoded: Uint8Array): number {
    const view = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength
    );
    let offset = 0;
    let count = 0;
    while (offset < encoded.length) {
      const length = view.getUint32(offset, false);
      offset += 4 + length;
      count++;
    }
    return count;
  }

  // Dynamic import so the mock is resolved at call time
  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a single request when chunks <= MAX_CHUNKS_PER_REQUEST', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok'));

    const streamer = await getStreamer();
    const chunks = Array.from(
      { length: MAX_CHUNKS_PER_REQUEST },
      (_, i) => new Uint8Array([i & 0xff])
    );

    await streamer.streams.writeMulti?.('run-1', 's', chunks);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('paginates into multiple requests when chunks > MAX_CHUNKS_PER_REQUEST', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok'));

    const streamer = await getStreamer();
    const totalChunks = MAX_CHUNKS_PER_REQUEST + 1;
    const chunks = Array.from(
      { length: totalChunks },
      (_, i) => new Uint8Array([i & 0xff])
    );

    await streamer.streams.writeMulti?.('run-1', 's', chunks);

    // Should split into 2 requests: one with MAX_CHUNKS_PER_REQUEST, one with 1
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('splits into correct chunk counts per page', async () => {
    const chunkCounts: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.body instanceof Uint8Array) {
        chunkCounts.push(countChunksInBody(init.body));
      }
      return new Response('ok');
    });

    const streamer = await getStreamer();
    const totalChunks = MAX_CHUNKS_PER_REQUEST * 2 + 5;
    const chunks = Array.from(
      { length: totalChunks },
      (_, i) => new Uint8Array([i & 0xff])
    );

    await streamer.streams.writeMulti?.('run-1', 's', chunks);

    expect(chunkCounts).toEqual([
      MAX_CHUNKS_PER_REQUEST,
      MAX_CHUNKS_PER_REQUEST,
      5,
    ]);
  });
});
