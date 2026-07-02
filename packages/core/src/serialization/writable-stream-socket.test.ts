import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable fake world, swapped per test. getWorldLazy is mocked to return it.
let currentWorld: any;
vi.mock('../runtime/get-world-lazy.js', () => ({
  getWorldLazy: async () => currentWorld,
}));

const { WorkflowServerWritableStream } = await import('../serialization.js');

/** Fake world recording which write path was exercised. */
function makeWorld(opts: { withConnectWrite: boolean }) {
  const calls = {
    channelFrames: [] as Uint8Array[],
    channels: 0,
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
  if (opts.withConnectWrite) {
    streams.connectWrite = async (
      _r: string,
      _n: string,
      handlers: { onAck(ack: { index: number; chunkIndex: number }): void }
    ) => {
      calls.channels++;
      let index = 0;
      return {
        send(frame: Uint8Array) {
          calls.channelFrames.push(frame);
          // Ack asynchronously, like a real backend.
          const i = index++;
          queueMicrotask(() =>
            handlers.onAck({ index: i, chunkIndex: 100 + i })
          );
        },
        close() {},
      };
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

  it('writes over the channel when the world supports connectWrite and a writerId is given', async () => {
    const { world, calls } = makeWorld({ withConnectWrite: true });
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

    // One channel carried both frames; no per-batch path used.
    expect(calls.channels).toBe(1);
    expect(calls.channelFrames.map((f) => f[0])).toEqual([10, 20]);
    expect(calls.writeMulti).toHaveLength(0);
    expect(calls.write).toHaveLength(0);
    // X-Stream-Done sent only after the frames were acked.
    expect(calls.closed).toBe(1);
  });

  it('falls back to the per-batch path when the world has no connectWrite', async () => {
    const { world, calls } = makeWorld({ withConnectWrite: false });
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

    // Per-batch path (writeMulti/write), never the channel. Sequential writer
    // writes flush one frame at a time, so they arrive via single write().
    expect(calls.channels).toBe(0);
    const batched = [...calls.writeMulti.flat(), ...calls.write];
    expect(batched.map((f) => f[0])).toEqual([10, 20]);
    expect(calls.closed).toBe(1);
  });

  it('uses the per-batch path when no writerId is provided (framed-v1)', async () => {
    const { world, calls } = makeWorld({ withConnectWrite: true });
    currentWorld = world;

    const ws = new WorkflowServerWritableStream('run-1', 'out');
    const writer = ws.getWriter();
    await writer.write(frame(10));
    await writer.close();

    // connectWrite is available but unused: without a writerId frames carry
    // no marker, so the read side couldn't deduplicate a reconnect resend —
    // stay on the batch path.
    expect(calls.channels).toBe(0);
    expect(calls.closed).toBe(1);
  });

  it('sends the done marker for an empty stream (close with no writes)', async () => {
    const { world, calls } = makeWorld({ withConnectWrite: true });
    currentWorld = world;

    const ws = new WorkflowServerWritableStream(
      'run-1',
      'out',
      undefined,
      WRITER_ID
    );
    await ws.getWriter().close();

    expect(calls.channels).toBe(0);
    expect(calls.closed).toBe(1);
  });
});
