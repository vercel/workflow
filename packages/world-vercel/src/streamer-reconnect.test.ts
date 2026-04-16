import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  parseStreamControlFrame,
  STREAM_CONTROL_FRAME_SIZE,
} from './streamer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a control frame matching the workflow-server wire format. */
function buildControlFrame(done: boolean, nextIndex: number): Uint8Array {
  const frame = new Uint8Array(STREAM_CONTROL_FRAME_SIZE);
  frame[4] = done ? 1 : 0;
  new DataView(frame.buffer).setUint32(5, nextIndex, false);
  frame.set(new Uint8Array([0x57, 0x46, 0x43, 0x54]), 9); // "WFCT"
  return frame;
}

/** Create a ReadableStream that emits the given byte chunks in order. */
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

/** Collect every byte from a ReadableStream into one Uint8Array. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

// ---------------------------------------------------------------------------
// Mock setup — isolate streamer from real auth / HTTP
// ---------------------------------------------------------------------------

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: () => Promise.resolve('test-token'),
}));

describe('streams.get reconnection (integration)', () => {
  let fetchMock: Mock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Import createStreamer lazily so the mock is in place. */
  async function getStreamer() {
    const { createStreamer } = await import('./streamer.js');
    return createStreamer({ token: 'test-token' });
  }

  /** Build a mock Response whose body is a ReadableStream of byte chunks. */
  function streamResponse(...chunks: Uint8Array[]): Response {
    return new Response(chunkedStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  it('returns data unchanged when server sends done=true control frame', async () => {
    const data = new TextEncoder().encode('hello');
    const control = buildControlFrame(true, 5);

    fetchMock.mockResolvedValueOnce(streamResponse(data, control));

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    expect(result).toEqual(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects when server sends done=false and resumes from nextIndex', async () => {
    const chunk1 = new TextEncoder().encode('aaa');
    const chunk2 = new TextEncoder().encode('bbb');
    const timeout = buildControlFrame(false, 3); // timeout at chunk 3
    const done = buildControlFrame(true, 6); // done on second connection

    // First connection: returns chunk1 + timeout control frame
    fetchMock.mockResolvedValueOnce(streamResponse(chunk1, timeout));
    // Second connection: returns chunk2 + done control frame
    fetchMock.mockResolvedValueOnce(streamResponse(chunk2, done));

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    // Should have received both chunks' data
    const expected = new Uint8Array([...chunk1, ...chunk2]);
    expect(result).toEqual(expected);

    // Should have made two fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call should have startIndex=3 (from control frame)
    const secondUrl = fetchMock.mock.calls[1][0] as URL;
    expect(secondUrl.toString()).toContain('startIndex=3');
  });

  it('handles multiple consecutive reconnections', async () => {
    const chunks = [
      new TextEncoder().encode('a'),
      new TextEncoder().encode('b'),
      new TextEncoder().encode('c'),
    ];

    fetchMock
      .mockResolvedValueOnce(
        streamResponse(chunks[0], buildControlFrame(false, 10))
      )
      .mockResolvedValueOnce(
        streamResponse(chunks[1], buildControlFrame(false, 20))
      )
      .mockResolvedValueOnce(
        streamResponse(chunks[2], buildControlFrame(true, 30))
      );

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    const expected = new Uint8Array([...chunks[0], ...chunks[1], ...chunks[2]]);
    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify startIndex progression
    const urls = fetchMock.mock.calls.map((c: unknown[]) =>
      (c[0] as URL).toString()
    );
    expect(urls[0]).toContain('startIndex=0');
    expect(urls[1]).toContain('startIndex=10');
    expect(urls[2]).toContain('startIndex=20');
  });

  it('passes startIndex from caller on initial connection', async () => {
    const data = new Uint8Array([42]);
    fetchMock.mockResolvedValueOnce(
      streamResponse(data, buildControlFrame(true, 8))
    );

    const streamer = await getStreamer();
    await drain(await streamer.streams.get('run_test', 'strm_test', 5));

    const url = (fetchMock.mock.calls[0][0] as URL).toString();
    expect(url).toContain('startIndex=5');
  });

  it('handles control frame split across two read chunks', async () => {
    const data = new TextEncoder().encode('hello');
    const control = buildControlFrame(true, 1);

    // Split the control frame in the middle (5 bytes + 8 bytes)
    const controlPart1 = control.slice(0, 5);
    const controlPart2 = control.slice(5);

    fetchMock.mockResolvedValueOnce(
      streamResponse(data, controlPart1, controlPart2)
    );

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    expect(result).toEqual(data);
  });

  it('handles data + control frame coalesced into one chunk', async () => {
    const data = new TextEncoder().encode('xyz');
    const control = buildControlFrame(true, 3);
    const combined = new Uint8Array(data.length + control.length);
    combined.set(data, 0);
    combined.set(control, data.length);

    fetchMock.mockResolvedValueOnce(streamResponse(combined));

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    expect(result).toEqual(data);
  });

  it('works with no data — only control frame (empty stream, done)', async () => {
    const control = buildControlFrame(true, 0);
    fetchMock.mockResolvedValueOnce(streamResponse(control));

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    expect(result.length).toBe(0);
  });

  it('works with no data — only control frame (immediate timeout, reconnects)', async () => {
    const timeout = buildControlFrame(false, 0);
    const data = new TextEncoder().encode('after-reconnect');
    const done = buildControlFrame(true, 5);

    fetchMock
      .mockResolvedValueOnce(streamResponse(timeout))
      .mockResolvedValueOnce(streamResponse(data, done));

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    expect(result).toEqual(data);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls through when no control frame is present (backward compat)', async () => {
    const data = new TextEncoder().encode('legacy server');

    // Old server: no control frame, just data
    fetchMock.mockResolvedValueOnce(streamResponse(data));

    const streamer = await getStreamer();
    const result = await drain(
      await streamer.streams.get('run_test', 'strm_test')
    );

    expect(result).toEqual(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates network error to consumer without retrying', async () => {
    const data = new TextEncoder().encode('partial');

    // Create a stream that errors mid-read
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

    fetchMock.mockResolvedValueOnce(new Response(errorStream, { status: 200 }));

    const streamer = await getStreamer();
    const stream = await streamer.streams.get('run_test', 'strm_test');

    // The error should propagate to the consumer rather than silently closing
    await expect(drain(stream)).rejects.toThrow('connection reset');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Should NOT have attempted a second fetch (no reconnection on error)
  });

  it('throws on non-200 response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const streamer = await getStreamer();
    await expect(
      streamer.streams.get('run_test', 'strm_missing')
    ).rejects.toThrow('Failed to fetch stream: 404');
  });
});
