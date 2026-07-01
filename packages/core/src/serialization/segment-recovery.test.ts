import { describe, expect, it, vi } from 'vitest';
import {
  buildFramedV2Frame,
  deriveWriterId,
  FRAME_HEADER_SIZE,
  readFrameMarker,
} from './frame-marker.js';
import {
  type RecoveryTransport,
  recoverStreamTail,
  type TailChunk,
} from './segment-recovery.js';

const WID = deriveWriterId('writer-A');
const OTHER = deriveWriterId('writer-B');

/** A complete framed-v2 frame (what getSerializeStream emits / the writer buffers). */
function frame(
  seq: number,
  payload: number[] = [seq],
  writerId = WID
): Uint8Array {
  return buildFramedV2Frame(new Uint8Array(payload), {
    writerId,
    seq: BigInt(seq),
  });
}

/** A persisted tail chunk — the server stores the inner frame verbatim. */
function chunk(index: number, seq: number, writerId = WID): TailChunk {
  return { index, data: frame(seq, [seq], writerId) };
}

/**
 * Fake transport. `snapshots` is a list of tail states consumed one per
 * getInfo/getChunks round, so tests can model a tail that fills in over
 * backoff. The last snapshot repeats. writeStream records replayed frames.
 */
function makeTransport(config: {
  snapshots: { tailIndex: number; chunks: TailChunk[] }[];
  writeStreamResult?: { chunkIndices: number[] } | (() => Promise<never>);
}) {
  // The readable tail grows across getChunks calls (models chunks becoming
  // readable over the recovery backoff). getInfo reports the currently-captured
  // tail without advancing.
  let round = 0;
  const replayed: Uint8Array[][] = [];

  const snapshotFor = (r: number) =>
    config.snapshots[Math.min(r, config.snapshots.length - 1)];

  const transport: RecoveryTransport = {
    async getInfo() {
      return { tailIndex: snapshotFor(round).tailIndex };
    },
    async getChunks() {
      const snapshot = snapshotFor(round);
      round++;
      return {
        data: snapshot.chunks,
        cursor: null,
        hasMore: false,
      };
    },
    async writeStream(frames) {
      const reader = frames.getReader();
      const got: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got.push(value);
      }
      replayed.push(got);
      if (typeof config.writeStreamResult === 'function') {
        return config.writeStreamResult();
      }
      return config.writeStreamResult ?? { chunkIndices: [] };
    },
  };

  return { transport, replayed };
}

const seqsOf = (frames: Uint8Array[]) =>
  frames.map((f) => Number(readFrameMarker(f.subarray(FRAME_HEADER_SIZE)).seq));

describe('recoverStreamTail', () => {
  it('replays all frames when nothing of ours is persisted yet', async () => {
    const { transport, replayed } = makeTransport({
      snapshots: [{ tailIndex: -1, chunks: [] }],
      writeStreamResult: { chunkIndices: [0, 1, 2] },
    });

    const result = await recoverStreamTail(
      [frame(0), frame(1), frame(2)],
      { writerId: WID, scanFromIndex: 0, sleep: async () => {} },
      transport
    );

    expect(result).toEqual({ chunkIndices: [0, 1, 2] });
    expect(replayed).toHaveLength(1);
    expect(seqsOf(replayed[0])).toEqual([0, 1, 2]);
  });

  it('replays only the suffix after our highest persisted seq', async () => {
    // Our frames seq 0,1 already persisted at indices 5,6.
    const { transport, replayed } = makeTransport({
      snapshots: [{ tailIndex: 6, chunks: [chunk(5, 0), chunk(6, 1)] }],
      writeStreamResult: { chunkIndices: [7, 8] },
    });

    const result = await recoverStreamTail(
      [frame(0), frame(1), frame(2), frame(3)],
      { writerId: WID, scanFromIndex: 5, sleep: async () => {} },
      transport
    );

    expect(result).toEqual({ chunkIndices: [7, 8] });
    expect(seqsOf(replayed[0])).toEqual([2, 3]);
  });

  it('ignores interleaved chunks from other writers when finding our max seq', async () => {
    // Index 5 = ours (seq 0), index 6 = another writer. tailIndex 6.
    const { transport, replayed } = makeTransport({
      snapshots: [
        {
          tailIndex: 6,
          chunks: [chunk(5, 0, WID), chunk(6, 42, OTHER)],
        },
      ],
      writeStreamResult: { chunkIndices: [7] },
    });

    await recoverStreamTail(
      [frame(0), frame(1)],
      { writerId: WID, scanFromIndex: 5, sleep: async () => {} },
      transport
    );

    // Our max persisted seq is 0 (the other writer's seq 42 is ignored), so
    // only seq 1 is replayed — and the foreign chunk did not trip the tail-gap
    // check (maxIndex reached tailIndex).
    expect(seqsOf(replayed[0])).toEqual([1]);
  });

  it('retries the tail read with backoff when a reserved tail chunk is not yet persisted', async () => {
    // Round 0: tailIndex 6 but only index 5 readable (index 6 reserved). After
    // one backoff, round 1 exposes index 6.
    const { transport, replayed } = makeTransport({
      snapshots: [
        { tailIndex: 6, chunks: [chunk(5, 0)] },
        { tailIndex: 6, chunks: [chunk(5, 0), chunk(6, 1)] },
      ],
      writeStreamResult: { chunkIndices: [7] },
    });
    const sleep = vi.fn(async () => {});

    await recoverStreamTail(
      [frame(0), frame(1), frame(2)],
      { writerId: WID, scanFromIndex: 5, backoffMs: [10, 100, 1000], sleep },
      transport
    );

    // Backed off once (10ms) before the tail chunk appeared.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
    // Persisted seq now 1, so only seq 2 is replayed.
    expect(seqsOf(replayed[0])).toEqual([2]);
  });

  it('surfaces a real error when a tail chunk never persists within the backoff window', async () => {
    const { transport } = makeTransport({
      // tailIndex 6 but index 6 never becomes readable.
      snapshots: [{ tailIndex: 6, chunks: [chunk(5, 0)] }],
    });
    const sleep = vi.fn(async () => {});

    await expect(
      recoverStreamTail(
        [frame(0), frame(1)],
        { writerId: WID, scanFromIndex: 5, backoffMs: [10, 100], sleep },
        transport
      )
    ).rejects.toThrow(/tail chunk 6 was reserved but never persisted/);
    // Exhausted both backoff steps.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not replay when everything in flight was already persisted', async () => {
    const { transport, replayed } = makeTransport({
      snapshots: [
        { tailIndex: 7, chunks: [chunk(5, 0), chunk(6, 1), chunk(7, 2)] },
      ],
    });

    const result = await recoverStreamTail(
      [frame(0), frame(1), frame(2)],
      { writerId: WID, scanFromIndex: 5, sleep: async () => {} },
      transport
    );

    expect(result).toEqual({ chunkIndices: [] });
    expect(replayed).toHaveLength(0);
  });

  it('gives up after maxAttempts when replay keeps failing', async () => {
    let calls = 0;
    const { transport } = makeTransport({
      snapshots: [{ tailIndex: -1, chunks: [] }],
      writeStreamResult: async () => {
        calls++;
        throw new Error('replay boom');
      },
    });

    await expect(
      recoverStreamTail(
        [frame(0)],
        {
          writerId: WID,
          scanFromIndex: 0,
          maxAttempts: 2,
          sleep: async () => {},
        },
        transport
      )
    ).rejects.toThrow(/replay boom/);
    expect(calls).toBe(2);
  });
});
