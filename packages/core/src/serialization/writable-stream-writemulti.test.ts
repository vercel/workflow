import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable fake world, swapped per test. getWorldLazy is mocked to return it.
let currentWorld: any;
vi.mock('../runtime/get-world-lazy.js', () => ({
  getWorldLazy: async () => currentWorld,
}));

const { WorkflowServerWritableStream } = await import('../serialization.js');

/** Fake world recording which write path was exercised. */
function makeWorld(opts?: { withWriteMulti?: boolean }) {
  const calls = {
    writeMulti: [] as { chunks: Uint8Array[]; options: unknown }[],
    write: [] as Uint8Array[],
    closed: 0,
  };
  const streams: any = {
    async write(_r: string, _n: string, chunk: Uint8Array) {
      calls.write.push(chunk);
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
  if (opts?.withWriteMulti !== false) {
    streams.writeMulti = async (
      _r: string,
      _n: string,
      chunks: Uint8Array[],
      options: unknown
    ) => {
      calls.writeMulti.push({ chunks, options });
    };
  }
  // Minimal shape to satisfy getWorldLazy's consumer; protocol assert is bypassed
  // because getWorldLazy itself is mocked.
  return { world: { streams } as any, calls };
}

const frame = (...b: number[]) => new Uint8Array(b);
const WRITER_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe('WorkflowServerWritableStream write delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grants retransmitSafe delivery when frames carry a writerId (framed-v2)', async () => {
    const { world, calls } = makeWorld();
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

    // Marked frames always flush through writeMulti (even one at a time, so
    // a world holding a long-lived channel keeps every chunk on it), with
    // the retransmit grant attached; single-chunk write() is never used.
    expect(calls.writeMulti.length).toBeGreaterThan(0);
    expect(calls.write).toHaveLength(0);
    expect(calls.writeMulti.flatMap((c) => c.chunks.map((f) => f[0]))).toEqual([
      10, 20,
    ]);
    for (const call of calls.writeMulti) {
      expect(call.options).toEqual({ retransmitSafe: true });
    }
    expect(calls.closed).toBe(1);
  });

  it('withholds the grant when no writerId is provided (framed-v1)', async () => {
    const { world, calls } = makeWorld();
    currentWorld = world;

    const ws = new WorkflowServerWritableStream('run-1', 'out');
    const writer = ws.getWriter();
    await writer.write(frame(10));
    await writer.close();

    // Unmarked frames can't be deduplicated by readers, so the world must
    // not receive a retransmit grant: sequential single-frame flushes go
    // through plain write().
    expect(calls.writeMulti).toHaveLength(0);
    expect(calls.write.map((f) => f[0])).toEqual([10]);
    expect(calls.closed).toBe(1);
  });

  it('falls back to sequential write() when the world has no writeMulti', async () => {
    const { world, calls } = makeWorld({ withWriteMulti: false });
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

    expect(calls.write.map((f) => f[0])).toEqual([10, 20]);
    expect(calls.closed).toBe(1);
  });

  it('sends the done marker for an empty stream (close with no writes)', async () => {
    const { world, calls } = makeWorld();
    currentWorld = world;

    const ws = new WorkflowServerWritableStream(
      'run-1',
      'out',
      undefined,
      WRITER_ID
    );
    await ws.getWriter().close();

    expect(calls.writeMulti).toHaveLength(0);
    expect(calls.write).toHaveLength(0);
    expect(calls.closed).toBe(1);
  });
});
