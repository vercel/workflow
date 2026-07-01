import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEGMENT_CONFIG,
  type SegmentWriterConfig,
  type SegmentWriterDeps,
  StreamSegmentWriter,
} from './segment-writer.js';

/**
 * Manual clock + timer scheduler so soft-close / idle timing is deterministic
 * (no wall-clock waits, no vitest fake-timer Date coupling).
 */
class FakeClock {
  t = 0;
  private timers: { id: number; fn: () => void; dueAt: number }[] = [];
  private nextId = 1;

  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, fn, dueAt: this.t + ms });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== handle);
  };

  /** Advance time and fire any due timers (in due order), then drain microtasks. */
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.timers
      .filter((x) => x.dueAt <= this.t)
      .sort((a, b) => a.dueAt - b.dueAt);
    this.timers = this.timers.filter((x) => x.dueAt > this.t);
    for (const timer of due) timer.fn();
    await flush();
  }
}

/** Let queued microtasks (async finalize steps) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface OpenedSegment {
  frames: Uint8Array[];
  /** Resolve/reject controls; by default resolves with sequential indices. */
  settle: 'auto' | 'fail';
}

/**
 * Fake transport. Each `writeStream` drains its body into a per-segment frames
 * array (so tests can assert what was streamed) and then, once the body is
 * closed, resolves with sequential chunk indices — or rejects if that segment
 * was marked to fail.
 */
function makeTransport(opts: { failSegments?: number[] } = {}) {
  const failSet = new Set(opts.failSegments ?? []);
  const opened: OpenedSegment[] = [];
  let nextIndex = 0;

  const writeStream = async (
    frames: ReadableStream<Uint8Array>
  ): Promise<{ chunkIndices: number[] }> => {
    const segmentNumber = opened.length;
    const record: OpenedSegment = {
      frames: [],
      settle: failSet.has(segmentNumber) ? 'fail' : 'auto',
    };
    opened.push(record);
    const reader = frames.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      record.frames.push(value);
    }
    if (record.settle === 'fail') {
      throw new Error(`segment ${segmentNumber} failed`);
    }
    const chunkIndices = record.frames.map(() => nextIndex++);
    return { chunkIndices };
  };

  return { opened, writeStream };
}

function makeWriter(
  deps: Partial<SegmentWriterDeps>,
  clock: FakeClock,
  config: SegmentWriterConfig = DEFAULT_SEGMENT_CONFIG
): StreamSegmentWriter {
  return new StreamSegmentWriter(
    {
      writeStream: deps.writeStream as SegmentWriterDeps['writeStream'],
      recover: deps.recover,
      ensureReady: deps.ensureReady,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
    config
  );
}

const frame = (...bytes: number[]) => new Uint8Array(bytes);

describe('StreamSegmentWriter', () => {
  it('streams frames into one segment and commits them in order on close()', async () => {
    const clock = new FakeClock();
    const transport = makeTransport();
    const writer = makeWriter(transport, clock);

    await writer.write(frame(1));
    await writer.write(frame(2));
    await writer.write(frame(3));
    expect(writer.pendingCount).toBe(3);

    await writer.close();

    expect(transport.opened).toHaveLength(1);
    expect(transport.opened[0].frames.map((f) => f[0])).toEqual([1, 2, 3]);
    // Clean commit dropped the buffer and recorded the segment's indices.
    expect(writer.pendingCount).toBe(0);
    expect(writer.committedIndices).toEqual([0, 1, 2]);
  });

  it('soft-closes at maxFrames and starts a new segment for the overflowing frame', async () => {
    const clock = new FakeClock();
    const transport = makeTransport();
    const writer = makeWriter({ ...transport }, clock, {
      ...DEFAULT_SEGMENT_CONFIG,
      maxFrames: 2,
    });

    await writer.write(frame(1));
    await writer.write(frame(2));
    // The 3rd frame would exceed maxFrames=2, so segment 1 is finalized first.
    await writer.write(frame(3));
    await writer.close();

    expect(transport.opened.map((s) => s.frames.map((f) => f[0]))).toEqual([
      [1, 2],
      [3],
    ]);
    // Indices are contiguous across serialized segments.
    expect(writer.committedIndices).toEqual([2]);
  });

  it('soft-closes when a segment exceeds its wall-clock budget', async () => {
    const clock = new FakeClock();
    const transport = makeTransport();
    const writer = makeWriter({ ...transport }, clock, {
      ...DEFAULT_SEGMENT_CONFIG,
      softCloseMs: 1000,
      idleMs: 10_000, // keep idle out of the way
    });

    await writer.write(frame(1));
    clock.t += 1000; // segment now at its time budget
    // The before-check finalizes segment 1 ([1]) before frame 2 joins segment 2.
    await writer.write(frame(2));
    await writer.close();

    expect(transport.opened.map((s) => s.frames.map((f) => f[0]))).toEqual([
      [1],
      [2],
    ]);
  });

  it('finalizes a quiet segment when the idle timer fires', async () => {
    const clock = new FakeClock();
    const transport = makeTransport();
    const writer = makeWriter({ ...transport }, clock, {
      ...DEFAULT_SEGMENT_CONFIG,
      idleMs: 100,
    });

    await writer.write(frame(7));
    expect(writer.pendingCount).toBe(1);

    // No further writes; the idle timer commits the segment.
    await clock.advance(100);

    expect(transport.opened).toHaveLength(1);
    expect(writer.pendingCount).toBe(0);
    expect(writer.committedIndices).toEqual([0]);

    // A subsequent write opens a fresh segment.
    await writer.write(frame(8));
    await writer.close();
    expect(transport.opened).toHaveLength(2);
    expect(transport.opened[1].frames.map((f) => f[0])).toEqual([8]);
  });

  it('recovers unconfirmed frames when a segment fails uncleanly', async () => {
    const clock = new FakeClock();
    const transport = makeTransport({ failSegments: [0] });
    let recovered: Uint8Array[] | undefined;
    const writer = makeWriter(
      {
        ...transport,
        recover: async (unconfirmed, _priorIndices) => {
          recovered = unconfirmed;
          return { chunkIndices: [100, 101] };
        },
      },
      clock
    );

    await writer.write(frame(1));
    await writer.write(frame(2));
    // close() finalizes segment 0, which fails → recover runs.
    await writer.close();

    expect(recovered?.map((f) => f[0])).toEqual([1, 2]);
    expect(writer.pendingCount).toBe(0);
    expect(writer.committedIndices).toEqual([100, 101]);
  });

  it('propagates an unclean failure when no recover is provided', async () => {
    const clock = new FakeClock();
    const transport = makeTransport({ failSegments: [0] });
    const writer = makeWriter({ ...transport }, clock);

    await writer.write(frame(1));
    await expect(writer.close()).rejects.toThrow(/segment 0 failed/);
  });

  it('abort discards unconfirmed frames and does not commit', async () => {
    const clock = new FakeClock();
    const transport = makeTransport();
    const writer = makeWriter({ ...transport }, clock);

    await writer.write(frame(1));
    await writer.abort(new Error('stop'));

    expect(writer.pendingCount).toBe(0);
    expect(writer.committedIndices).toEqual([]);
    await expect(writer.write(frame(2))).rejects.toThrow(/aborted/);
  });

  it('awaits ensureReady exactly once before the first segment', async () => {
    const clock = new FakeClock();
    const transport = makeTransport();
    let readyCalls = 0;
    const writer = makeWriter(
      {
        ...transport,
        ensureReady: async () => {
          readyCalls++;
        },
      },
      clock,
      { ...DEFAULT_SEGMENT_CONFIG, maxFrames: 1 }
    );

    await writer.write(frame(1)); // opens segment 0
    await writer.write(frame(2)); // opens segment 1
    await writer.close();

    expect(transport.opened.length).toBeGreaterThanOrEqual(2);
    expect(readyCalls).toBe(1);
  });
});
