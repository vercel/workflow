import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable fake world, swapped per test. getWorldLazy is mocked to return it.
let currentWorld: any;
vi.mock('../runtime/get-world-lazy.js', () => ({
  getWorldLazy: async () => currentWorld,
}));

const { WorkflowServerWritableStream } = await import('../serialization.js');

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = body.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/** Fake streamer recording which write path was exercised. */
function makeWorld(opts: { withWriteStream: boolean }) {
  const calls = {
    writeStream: [] as Uint8Array[][],
    writeMulti: [] as Uint8Array[][],
    write: [] as Uint8Array[],
    closed: 0,
  };
  const streams: any = {
    async write(_r: string, _n: string, chunk: Uint8Array) {
      calls.write.push(chunk);
    },
    async writeMulti(_r: string, _n: string, chunks: Uint8Array[]) {
      calls.writeMulti.push(chunks);
    },
    async close() {
      calls.closed++;
    },
    async getInfo() {
      return { tailIndex: -1, done: false };
    },
    async getChunks() {
      return { data: [], cursor: null, hasMore: false, done: false };
    },
  };
  if (opts.withWriteStream) {
    let next = 0;
    streams.writeStream = async (
      _r: string,
      _n: string,
      body: ReadableStream<Uint8Array>
    ) => {
      const frames = await drain(body);
      calls.writeStream.push(frames);
      return { chunkIndices: frames.map(() => next++) };
    };
  }
  // Minimal shape to satisfy getWorldLazy's consumer; protocol assert is bypassed
  // because getWorldLazy itself is mocked.
  return { world: { streams } as any, calls };
}

const frame = (...b: number[]) => new Uint8Array(b);
const WRITER_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe('WorkflowServerWritableStream sink selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streams via writeStream when the world supports it and a writerId is given', async () => {
    const { world, calls } = makeWorld({ withWriteStream: true });
    currentWorld = world;

    const ws = new WorkflowServerWritableStream(
      'run-1',
      'out',
      undefined,
      WRITER_ID
    );
    const writer = ws.getWriter();
    await writer.write(frame(10));
    await writer.write(frame(20));
    await writer.close();

    // One segment carried both frames; no per-batch path used.
    expect(calls.writeStream).toHaveLength(1);
    expect(calls.writeStream[0].map((f) => f[0])).toEqual([10, 20]);
    expect(calls.writeMulti).toHaveLength(0);
    expect(calls.write).toHaveLength(0);
    // X-Stream-Done sent after the frames committed.
    expect(calls.closed).toBe(1);
  });

  it('falls back to the per-batch path when the world has no writeStream', async () => {
    const { world, calls } = makeWorld({ withWriteStream: false });
    currentWorld = world;

    const ws = new WorkflowServerWritableStream(
      'run-1',
      'out',
      undefined,
      WRITER_ID
    );
    const writer = ws.getWriter();
    await writer.write(frame(10));
    await writer.write(frame(20));
    await writer.close();

    // Per-batch path (writeMulti/write), never streamed. Sequential writer
    // writes flush one frame at a time, so they arrive via single write().
    expect(calls.writeStream).toHaveLength(0);
    const batched = [...calls.writeMulti.flat(), ...calls.write];
    expect(batched.map((f) => f[0])).toEqual([10, 20]);
    expect(calls.closed).toBe(1);
  });

  it('uses the per-batch path when no writerId is provided (framed-v1)', async () => {
    const { world, calls } = makeWorld({ withWriteStream: true });
    currentWorld = world;

    const ws = new WorkflowServerWritableStream('run-1', 'out');
    const writer = ws.getWriter();
    await writer.write(frame(10));
    await writer.close();

    // writeStream is available but unused: without a writerId frames carry no
    // marker, so recovery can't attribute them — stay on the batch path.
    expect(calls.writeStream).toHaveLength(0);
    expect(calls.closed).toBe(1);
  });

  it('sends the done marker for an empty stream (close with no writes)', async () => {
    const { world, calls } = makeWorld({ withWriteStream: true });
    currentWorld = world;

    const ws = new WorkflowServerWritableStream(
      'run-1',
      'out',
      undefined,
      WRITER_ID
    );
    await ws.getWriter().close();

    expect(calls.writeStream).toHaveLength(0);
    expect(calls.closed).toBe(1);
  });
});
