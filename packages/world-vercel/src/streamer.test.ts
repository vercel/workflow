import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeMultiChunks,
  MAX_CHUNKS_PER_REQUEST,
  parseStreamControlFrame,
  STREAM_CONTROL_FRAME_SIZE,
} from './streamer.js';

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

/**
 * Build a control frame matching the workflow-server format.
 */
function buildControlFrame(done: boolean, nextIndex: number): Uint8Array {
  const frame = new Uint8Array(STREAM_CONTROL_FRAME_SIZE);
  // Bytes 0-3: zero-frame marker (already 0x00)
  frame[4] = done ? 1 : 0;
  new DataView(frame.buffer).setUint32(5, nextIndex, false);
  // Magic footer "WFCT"
  frame.set(new Uint8Array([0x57, 0x46, 0x43, 0x54]), 9);
  return frame;
}

describe('parseStreamControlFrame', () => {
  it('parses a valid done=true control frame', () => {
    const frame = buildControlFrame(true, 42);
    const result = parseStreamControlFrame(frame);
    expect(result).toEqual({
      done: true,
      nextIndex: 42,
      totalLength: STREAM_CONTROL_FRAME_SIZE,
    });
  });

  it('parses a valid done=false (timeout) control frame', () => {
    const frame = buildControlFrame(false, 100);
    const result = parseStreamControlFrame(frame);
    expect(result).toEqual({
      done: false,
      nextIndex: 100,
      totalLength: STREAM_CONTROL_FRAME_SIZE,
    });
  });

  it('parses control frame appended after data bytes', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = buildControlFrame(false, 7);
    const combined = new Uint8Array(data.length + frame.length);
    combined.set(data, 0);
    combined.set(frame, data.length);

    const result = parseStreamControlFrame(combined);
    expect(result).toEqual({
      done: false,
      nextIndex: 7,
      totalLength: STREAM_CONTROL_FRAME_SIZE,
    });
  });

  it('returns null for buffer shorter than control frame size', () => {
    expect(parseStreamControlFrame(new Uint8Array(12))).toBeNull();
    expect(parseStreamControlFrame(new Uint8Array(0))).toBeNull();
  });

  it('returns null when magic footer does not match', () => {
    const frame = buildControlFrame(true, 0);
    frame[12] = 0xff; // corrupt magic footer
    expect(parseStreamControlFrame(frame)).toBeNull();
  });

  it('returns null when zero-frame marker is not all zeros', () => {
    const frame = buildControlFrame(true, 0);
    frame[0] = 1; // corrupt zero-frame marker
    expect(parseStreamControlFrame(frame)).toBeNull();
  });

  it('handles nextIndex=0', () => {
    const frame = buildControlFrame(false, 0);
    const result = parseStreamControlFrame(frame);
    expect(result).toEqual({
      done: false,
      nextIndex: 0,
      totalLength: STREAM_CONTROL_FRAME_SIZE,
    });
  });

  it('handles large nextIndex values', () => {
    const frame = buildControlFrame(true, 0xffffffff);
    const result = parseStreamControlFrame(frame);
    expect(result?.nextIndex).toBe(0xffffffff);
  });
});

describe('streams.get reconnection', () => {
  /**
   * Helper to create a ReadableStream from chunks, optionally appending
   * a control frame to the last chunk or as a separate chunk.
   */
  function makeServerStream(
    dataChunks: Uint8Array[],
    controlFrame?: Uint8Array
  ): ReadableStream<Uint8Array> {
    const chunks = [...dataChunks];
    if (controlFrame) {
      chunks.push(controlFrame);
    }
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
        } else {
          controller.close();
        }
      },
    });
  }

  /**
   * Collect all bytes from a ReadableStream into a single Uint8Array.
   */
  async function collectStream(
    stream: ReadableStream<Uint8Array>
  ): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  it('strips control frame and returns only data when done=true', async () => {
    const data = new TextEncoder().encode('hello world');
    const control = buildControlFrame(true, 99);

    const allBytes = await collectStream(makeServerStream([data], control));

    // The raw stream contains data + control
    expect(allBytes.length).toBe(data.length + control.length);

    // parseStreamControlFrame should find the control frame at the tail
    const parsed = parseStreamControlFrame(allBytes);
    expect(parsed).toEqual({
      done: true,
      nextIndex: 99,
      totalLength: STREAM_CONTROL_FRAME_SIZE,
    });

    // Data portion should match
    const dataPortion = allBytes.subarray(
      0,
      allBytes.length - parsed!.totalLength
    );
    expect(dataPortion).toEqual(data);
  });

  it('control frame embedded in same chunk as data is correctly parsed', async () => {
    const data = new Uint8Array([10, 20, 30]);
    const control = buildControlFrame(false, 5);

    // Combine into a single chunk (simulates TCP coalescing)
    const combined = new Uint8Array(data.length + control.length);
    combined.set(data, 0);
    combined.set(control, data.length);

    const parsed = parseStreamControlFrame(combined);
    expect(parsed).not.toBeNull();
    expect(parsed!.done).toBe(false);
    expect(parsed!.nextIndex).toBe(5);

    const dataPortion = combined.subarray(
      0,
      combined.length - parsed!.totalLength
    );
    expect(dataPortion).toEqual(data);
  });

  it('no false positive on data that happens to end with zero bytes', async () => {
    // Create data ending with zeros but no valid magic footer
    const data = new Uint8Array(20);
    data.fill(0);
    data[19] = 0x42; // not "WFCT"

    const parsed = parseStreamControlFrame(data);
    expect(parsed).toBeNull();
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

describe('streams.get', () => {
  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes runId in the fetch URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(new ReadableStream(), { status: 200 })
      );

    const streamer = await getStreamer();
    await streamer.streams.get('run-123', 'my-stream');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v3/runs/run-123/stream/my-stream');
  });

  it('passes startIndex as a query parameter', async () => {
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
