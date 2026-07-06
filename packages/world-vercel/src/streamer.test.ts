import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMultiChunks, MAX_CHUNKS_PER_REQUEST } from './streamer.js';

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
}));

/**
 * Fake in place of undici's WebSocket (which supports custom upgrade
 * headers, unlike the WHATWG global — that's why connectWrite uses it).
 * Tests drive open/message/close/error events by hand.
 */
interface FakeSocket {
  url: unknown;
  init: unknown;
  sent: unknown[];
  closeCalls: { code?: number; reason?: string }[];
  emit(type: string, event: unknown): void;
}
const fakeSockets = vi.hoisted(() => [] as unknown[]) as FakeSocket[];
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  class FakeWebSocket {
    url: unknown;
    init: unknown;
    sent: unknown[] = [];
    closeCalls: { code?: number; reason?: string }[] = [];
    private listeners = new Map<
      string,
      { cb: (event: unknown) => void; once?: boolean }[]
    >();

    constructor(url: unknown, init: unknown) {
      this.url = url;
      this.init = init;
      (fakeSockets as unknown[]).push(this);
    }
    addEventListener(
      type: string,
      cb: (event: unknown) => void,
      opts?: { once?: boolean }
    ) {
      const list = this.listeners.get(type) ?? [];
      list.push({ cb, once: opts?.once });
      this.listeners.set(type, list);
    }
    emit(type: string, event: unknown) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        list.filter((l) => !l.once)
      );
      for (const { cb } of list) cb(event);
    }
    send(chunk: unknown) {
      this.sent.push(chunk);
    }
    close(code?: number, reason?: string) {
      this.closeCalls.push({ code, reason });
    }
  }
  return { ...actual, WebSocket: FakeWebSocket };
});

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
      'Stream write failed: HTTP 500 (PUT https://test.example.com/v3/runs/wrun_test/stream/user; x-vercel-id=sfo1::abc; x-vercel-error=FUNCTION_INVOCATION_FAILED): Internal Server Error\nrequest-token'
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
    // Batch writes target the v3 endpoint (per-chunk publish), not v2.
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v3/runs/run-1/stream/s');
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

describe('streams.connectWrite (WebSocket write channel)', () => {
  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    fakeSockets.length = 0;
  });

  /** connectWrite awaits config before constructing the socket. */
  async function lastSocket() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = fakeSockets[fakeSockets.length - 1];
    if (!socket) throw new Error('no WebSocket constructed');
    return socket;
  }

  async function openChannel(handlers?: {
    onAck?: (ack: { index: number; chunkIndex: number }) => void;
    onClose?: (event: { code?: number; reason?: string }) => void;
  }) {
    const streamer = await getStreamer();
    const channelPromise = streamer.streams.connectWrite?.('run-9', 'out', {
      onAck: handlers?.onAck ?? (() => {}),
      onClose: handlers?.onClose ?? (() => {}),
    });
    const socket = await lastSocket();
    socket.emit('open', {});
    const channel = await channelPromise;
    if (!channel) throw new Error('connectWrite not implemented');
    return { channel, socket };
  }

  it('upgrades on the v3 /ws path with the auth headers from getHttpConfig', async () => {
    const { getHttpConfig } = await import('./utils.js');
    (getHttpConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      baseUrl: 'https://test.example.com',
      headers: new Headers({ Authorization: 'Bearer tok' }),
    });

    const { socket } = await openChannel();
    const url = new URL(String(socket.url));
    // wss on the dedicated write-channel path: any hit here in request logs
    // is a streaming-mode writer.
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v3/runs/run-9/stream/out/ws');
    // The upgrade authenticates like every HTTP call (undici WebSocket
    // accepts custom headers, unlike the WHATWG global).
    expect(
      (socket.init as { headers: Record<string, string> }).headers
        .authorization ??
        (socket.init as { headers: Record<string, string> }).headers
          .Authorization
    ).toBe('Bearer tok');
  });

  it('sends chunks and surfaces acks in order', async () => {
    const acks: { index: number; chunkIndex: number }[] = [];
    const { channel, socket } = await openChannel({
      onAck: (ack) => acks.push(ack),
    });

    channel.send(new Uint8Array([1]));
    channel.send(new Uint8Array([2]));
    expect(socket.sent).toHaveLength(2);

    socket.emit('message', {
      data: JSON.stringify({ index: 0, chunkIndex: 5 }),
    });
    socket.emit('message', {
      data: JSON.stringify({ index: 1, chunkIndex: 6 }),
    });
    expect(acks).toEqual([
      { index: 0, chunkIndex: 5 },
      { index: 1, chunkIndex: 6 },
    ]);
  });

  it('fires onClose exactly once across close and error events', async () => {
    const closes: { code?: number; reason?: string }[] = [];
    const { socket } = await openChannel({
      onClose: (event) => closes.push(event),
    });

    socket.emit('close', { code: 1006, reason: 'cut' });
    socket.emit('error', {});
    socket.emit('close', { code: 1006, reason: 'cut again' });

    expect(closes).toEqual([{ code: 1006, reason: 'cut' }]);
  });

  it('rejects the connect when the socket closes before opening', async () => {
    const streamer = await getStreamer();
    const channelPromise = streamer.streams.connectWrite?.('run-9', 'out', {
      onAck: () => {},
      onClose: () => {},
    });
    (await lastSocket()).emit('close', { code: 4401, reason: 'unauthorized' });

    await expect(channelPromise).rejects.toThrow(
      /failed to connect: 4401 unauthorized/
    );
  });

  it('fails the channel on an unparseable server message', async () => {
    const closes: { code?: number; reason?: string }[] = [];
    const { socket } = await openChannel({
      onClose: (event) => closes.push(event),
    });

    socket.emit('message', { data: 'not json' });

    expect(closes).toEqual([{ reason: 'unparseable ack from server' }]);
    expect(socket.closeCalls).toHaveLength(1);
  });
});
