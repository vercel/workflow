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

describe('writeToStreamMulti pagination', () => {
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

    await streamer.writeToStreamMulti?.('s', 'run-1', chunks);

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

    await streamer.writeToStreamMulti?.('s', 'run-1', chunks);

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

    await streamer.writeToStreamMulti?.('s', 'run-1', chunks);

    expect(chunkCounts).toEqual([
      MAX_CHUNKS_PER_REQUEST,
      MAX_CHUNKS_PER_REQUEST,
      5,
    ]);
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

describe('readFromStream reconnection', () => {
  /** Collect every byte from a ReadableStream into one Uint8Array. */
  async function drain(
    stream: ReadableStream<Uint8Array>
  ): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
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

  function streamResponse(...chunks: Uint8Array[]): Response {
    return new Response(chunkedStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects when server sends done=false and resumes from nextIndex', async () => {
    const chunk1 = new TextEncoder().encode('aaa');
    const chunk2 = new TextEncoder().encode('bbb');
    const timeout = buildControlFrame(false, 3);
    const done = buildControlFrame(true, 6);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(streamResponse(chunk1, timeout))
      .mockResolvedValueOnce(streamResponse(chunk2, done));

    const streamer = await getStreamer();
    const result = await drain(await streamer.readFromStream('strm_test'));

    const expected = new Uint8Array([...chunk1, ...chunk2]);
    expect(result).toEqual(expected);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const secondUrl = new URL(fetchSpy.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get('startIndex')).toBe('3');
  });

  it('falls through when no control frame is present (backward compat)', async () => {
    const data = new TextEncoder().encode('legacy server');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(streamResponse(data));

    const streamer = await getStreamer();
    const result = await drain(await streamer.readFromStream('strm_test'));

    expect(result).toEqual(data);
  });

  it('propagates network error to consumer without retrying', async () => {
    const data = new TextEncoder().encode('partial');

    let callCount = 0;
    const errorStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (callCount === 0) {
          callCount++;
          controller.enqueue(data);
        } else {
          controller.error(new Error('connection reset'));
        }
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(errorStream, { status: 200 })
    );

    const streamer = await getStreamer();
    // readFromStream returns the ReadableStream before the error surfaces,
    // so the error propagates while draining — not on readFromStream itself.
    const stream = await streamer.readFromStream('strm_test');
    await expect(drain(stream)).rejects.toThrow('connection reset');
  });

  // Regression test for the 4.2.3 streaming break: a prior fix drained the
  // upstream via `await response.arrayBuffer()` before returning the
  // ReadableStream, which caused `run.getReadable()` to block until the
  // entire stream had completed on the server — nothing arrived in the UI
  // incrementally. This test asserts that data flows to the consumer before
  // upstream close; any buffer-then-replay rewrite fails here.
  it('emits upstream bytes to the consumer before the stream closes', async () => {
    // 100-byte chunk: 13 held back for control-frame detection, 87 must
    // reach the consumer without waiting for close.
    const chunk = new Uint8Array(100).fill(0x41);

    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        upstreamController = c;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(body, { status: 200 })
    );

    const streamer = await getStreamer();
    const stream = await streamer.readFromStream('strm_test');
    const reader = stream.getReader();

    // Deliver the chunk but DO NOT close upstream yet.
    upstreamController.enqueue(chunk);

    // Consumer must receive the non-held-back prefix without waiting for
    // upstream close. Cap the wait so a buffered impl fails fast.
    const result = await Promise.race([
      reader.read(),
      new Promise<'TIMED_OUT'>((resolve) =>
        setTimeout(() => resolve('TIMED_OUT'), 200)
      ),
    ]);

    expect(result).not.toBe('TIMED_OUT');
    if (result === 'TIMED_OUT') return;
    expect(result.done).toBe(false);
    expect(result.value?.length).toBe(100 - STREAM_CONTROL_FRAME_SIZE);

    await reader.cancel();
  });
});
