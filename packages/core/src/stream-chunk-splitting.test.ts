import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./version.js', () => ({ version: '0.0.0-test' }));

import { getRunCapabilities } from './capabilities.js';
import { importKey } from './encryption.js';
import { setWorld } from './runtime/world.js';
import { deriveRunKeyPair } from './sealed-box.js';
import {
  createSplitReassembler,
  decodeSplitPart,
  MAX_SPLIT_PARTS,
  MAX_SPLIT_VALUE_BYTES,
  SPLIT_HEADER_SIZE,
  SPLIT_PART_OVERHEAD_BYTES,
  splitPayload,
} from './serialization/split-frames.js';
import {
  createReconnectingFramedStream,
  getDeserializeStream,
  getSerializeStream,
  runPayloadKeys,
  sealTo,
} from './serialization.js';

const FRAME_HEADER_SIZE = 4;
const RUN_ID = 'wrun_split';
const SPLIT_PREFIX = 'splt';

const decoder = new TextDecoder();

function frameLengthOf(frame: Uint8Array): number {
  return new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength
  ).getUint32(0, false);
}

function framePrefixOf(frame: Uint8Array): string {
  return decoder.decode(
    frame.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + 4)
  );
}

/** The `splt` payload of a frame: everything after the length + format prefix. */
function splitPayloadOf(frame: Uint8Array): Uint8Array {
  return frame.subarray(FRAME_HEADER_SIZE + 4);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Serializes `chunks` and returns the raw wire frames the producer emitted. */
async function writeFrames(
  chunks: unknown[],
  options: Parameters<typeof getSerializeStream>[2] = {},
  cryptoKey: Parameters<typeof getSerializeStream>[1] = undefined
): Promise<Uint8Array[]> {
  const serialize = getSerializeStream({}, cryptoKey, options);
  const frames: Uint8Array[] = [];
  const read = (async () => {
    const reader = serialize.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) frames.push(value);
    }
  })();
  const writer = serialize.writable.getWriter();
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
  await read;
  return frames;
}

/** Feeds raw wire frames through the deserializer and collects the values. */
async function readValues(
  frames: Uint8Array[],
  cryptoKey: Parameters<typeof getDeserializeStream>[1] = undefined
): Promise<unknown[]> {
  const deserialize = getDeserializeStream({}, cryptoKey);
  const values: unknown[] = [];
  const read = (async () => {
    const reader = deserialize.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      values.push(value);
    }
  })();
  const write = (async () => {
    const writer = deserialize.writable.getWriter();
    for (const frame of frames) await writer.write(frame);
    await writer.close();
  })();
  // An errored transform rejects both ends. Settle both so neither becomes an
  // unhandled rejection, then surface the read side, which carries the cause.
  const [readOutcome, writeOutcome] = await Promise.allSettled([read, write]);
  if (readOutcome.status === 'rejected') throw readOutcome.reason;
  if (writeOutcome.status === 'rejected') throw writeOutcome.reason;
  return values;
}

async function readAll(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value) out.push(r.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

describe('splitPayload / createSplitReassembler', () => {
  it('round-trips a payload through its parts', () => {
    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

    const parts = splitPayload(payload, 300, 0x1234abcd);
    expect(parts).toHaveLength(4);

    const reassembler = createSplitReassembler();
    const results = parts.map((part) => reassembler.accept(part.subarray(4)));
    expect(results.slice(0, 3).every((r) => r.kind === 'pending')).toBe(true);
    const last = results[3];
    expect(last.kind).toBe('complete');
    if (last.kind !== 'complete') throw new Error('unreachable');
    expect(last.payload).toEqual(payload);
    expect(reassembler.pending).toBe(false);
  });

  it('stamps every part of a group with the same id, count, and ordered index', () => {
    const parts = splitPayload(new Uint8Array(10), 4, 7);
    const decoded = parts.map((part) => decodeSplitPart(part.subarray(4)));
    expect(decoded.map((p) => p?.index)).toEqual([0, 1, 2]);
    expect(decoded.every((p) => p?.count === 3)).toBe(true);
    expect(decoded.every((p) => p?.groupId === 7)).toBe(true);
  });

  it('gives adjacent groups different ids', () => {
    const ids = new Set<number | undefined>();
    for (let i = 0; i < 50; i++) {
      const [first] = splitPayload(new Uint8Array(10), 4);
      ids.add(decodeSplitPart(first.subarray(4))?.groupId);
    }
    // 32 random bits: 50 draws colliding would be a broken generator, not luck.
    expect(ids.size).toBeGreaterThan(45);
  });

  it('refuses a payload no number of parts could carry', () => {
    expect(() =>
      splitPayload(new Uint8Array(10), 1 /* → 10 parts */, 1)
    ).not.toThrow();
    // One byte per part puts the part count over the u16 ceiling.
    expect(() => splitPayload(new Uint8Array(MAX_SPLIT_PARTS + 1), 1)).toThrow(
      /continuation frames; the maximum is/
    );
  });

  it('names the value size when it exceeds the shared ceiling', () => {
    // Allocating 100 MB in a unit test is wasteful; assert on the boundary the
    // splitter checks rather than on a real buffer.
    const oversized = { byteLength: MAX_SPLIT_VALUE_BYTES + 1 } as Uint8Array;
    expect(() => splitPayload(oversized, 1024)).toThrow(
      /exceeds the maximum size a split write can carry/
    );
  });

  describe('reassembly of imperfect input', () => {
    it('drops continuations whose group never started here', () => {
      // The mid-group read: a `startIndex` that lands on part 2 of 4.
      const parts = splitPayload(new Uint8Array(40), 10, 5);
      const reassembler = createSplitReassembler();
      expect(reassembler.accept(parts[2].subarray(4))).toEqual({
        kind: 'dropped',
        reason: 'orphaned',
      });
      expect(reassembler.accept(parts[3].subarray(4))).toEqual({
        kind: 'dropped',
        reason: 'orphaned',
      });
      expect(reassembler.pending).toBe(false);
    });

    it('resynchronises on the next complete group', () => {
      const dropped = splitPayload(new Uint8Array([1, 2, 3, 4]), 2, 11);
      const kept = splitPayload(new Uint8Array([9, 8, 7, 6]), 2, 12);
      const reassembler = createSplitReassembler();

      expect(reassembler.accept(dropped[1].subarray(4)).kind).toBe('dropped');
      expect(reassembler.accept(kept[0].subarray(4)).kind).toBe('pending');
      const result = reassembler.accept(kept[1].subarray(4));
      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') throw new Error('unreachable');
      expect(result.payload).toEqual(new Uint8Array([9, 8, 7, 6]));
    });

    it('drops a part that belongs to a different group', () => {
      const a = splitPayload(new Uint8Array([1, 2, 3, 4]), 2, 21);
      const b = splitPayload(new Uint8Array([5, 6, 7, 8]), 2, 22);
      const reassembler = createSplitReassembler();
      expect(reassembler.accept(a[0].subarray(4)).kind).toBe('pending');
      expect(reassembler.accept(b[1].subarray(4))).toEqual({
        kind: 'dropped',
        reason: 'out-of-order',
      });
    });

    it('drops a part that skips a position in the open group', () => {
      const parts = splitPayload(new Uint8Array(30), 10, 31);
      const reassembler = createSplitReassembler();
      expect(reassembler.accept(parts[0].subarray(4)).kind).toBe('pending');
      expect(reassembler.accept(parts[2].subarray(4))).toEqual({
        kind: 'dropped',
        reason: 'out-of-order',
      });
    });

    it('drops a header it cannot read instead of guessing', () => {
      const reassembler = createSplitReassembler();
      // Truncated header.
      expect(reassembler.accept(new Uint8Array(SPLIT_HEADER_SIZE - 1))).toEqual(
        { kind: 'dropped', reason: 'unreadable' }
      );
      // A future wire version.
      const future = new Uint8Array(SPLIT_HEADER_SIZE);
      new DataView(future.buffer).setUint8(0, 99);
      expect(reassembler.accept(future)).toEqual({
        kind: 'dropped',
        reason: 'unreadable',
      });
    });

    it('reports an unfinished group as pending so a reader can tell', () => {
      const parts = splitPayload(new Uint8Array(30), 10, 41);
      const reassembler = createSplitReassembler();
      reassembler.accept(parts[0].subarray(4));
      expect(reassembler.pending).toBe(true);
      reassembler.reset();
      expect(reassembler.pending).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The serialize / deserialize pipeline
// ---------------------------------------------------------------------------

describe('oversized object-stream writes', () => {
  it('splits a write larger than the chunk cap into several frames', async () => {
    const big = 'x'.repeat(4096);
    const frames = await writeFrames([big], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });

    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(framePrefixOf(frame)).toBe(SPLIT_PREFIX);
      // The whole point: every frame fits one wire chunk.
      expect(frame.byteLength).toBeLessThanOrEqual(1024);
    }
    await expect(readValues(frames)).resolves.toEqual([big]);
  });

  it('leaves a write that fits as a single unsplit frame', async () => {
    const frames = await writeFrames(['small'], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    expect(frames).toHaveLength(1);
    expect(framePrefixOf(frames[0])).toBe('devl');
  });

  it('interleaves split and unsplit writes without confusing the reader', async () => {
    const big = 'y'.repeat(4096);
    const frames = await writeFrames(['before', big, 'after'], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    await expect(readValues(frames)).resolves.toEqual(['before', big, 'after']);
  });

  it('produces byte-identical output to a pre-split producer when the capability is off', async () => {
    const big = 'z'.repeat(4096);
    const withGate = await writeFrames([big], {
      splitChunks: false,
      maxChunkBytes: 1024,
    });
    const legacy = await writeFrames([big]);
    expect(withGate).toHaveLength(1);
    expect(withGate[0]).toEqual(legacy[0]);
    // And the one frame is the oversized one the transport will refuse, which
    // is the explicit failure an old reader needs: it must not silently become
    // frames that reader would drop.
    expect(frameLengthOf(withGate[0])).toBeGreaterThan(1024);
  });

  it('is disabled by WORKFLOW_STREAM_SPLIT_CHUNKS=0', async () => {
    const previous = process.env.WORKFLOW_STREAM_SPLIT_CHUNKS;
    process.env.WORKFLOW_STREAM_SPLIT_CHUNKS = '0';
    try {
      const frames = await writeFrames(['q'.repeat(4096)], {
        splitChunks: true,
        maxChunkBytes: 1024,
      });
      expect(frames).toHaveLength(1);
      expect(framePrefixOf(frames[0])).toBe('devl');
    } finally {
      if (previous === undefined) {
        delete process.env.WORKFLOW_STREAM_SPLIT_CHUNKS;
      } else {
        process.env.WORKFLOW_STREAM_SPLIT_CHUNKS = previous;
      }
    }
  });

  it('resolves a lazily supplied capability once, on the first write', async () => {
    const splitChunks = vi.fn(async () => true);
    const frames = await writeFrames(['a'.repeat(4096), 'b'.repeat(4096)], {
      splitChunks,
      maxChunkBytes: 1024,
    });
    expect(splitChunks).toHaveBeenCalledTimes(1);
    expect(frames.every((f) => framePrefixOf(f) === SPLIT_PREFIX)).toBe(true);
  });

  it('does not split when the capability lookup fails', async () => {
    const frames = await writeFrames(['c'.repeat(4096)], {
      splitChunks: async () => {
        throw new Error('run metadata unavailable');
      },
      maxChunkBytes: 1024,
    });
    expect(frames).toHaveLength(1);
    expect(framePrefixOf(frames[0])).toBe('devl');
  });

  it('keeps the continuation header readable without a key on an encrypted stream', async () => {
    const key = await importKey(new Uint8Array(32).fill(0x7a));
    const big = 'e'.repeat(4096);
    const frames = await writeFrames(
      [big],
      { splitChunks: true, maxChunkBytes: 1024 },
      key
    );

    expect(frames.length).toBeGreaterThan(1);
    // The split wraps the finished ciphertext, so a reader with no key still
    // sees that these are fragments and which group they belong to.
    const groupIds = new Set(
      frames.map((f) => decodeSplitPart(splitPayloadOf(f))?.groupId)
    );
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBeTypeOf('number');

    await expect(readValues(frames, key)).resolves.toEqual([big]);
  });

  it('keeps one AEAD tag over the whole value, so a missing part cannot decode to a truncated one', async () => {
    const key = await importKey(new Uint8Array(32).fill(0x7b));
    const frames = await writeFrames(
      ['f'.repeat(4096)],
      { splitChunks: true, maxChunkBytes: 1024 },
      key
    );
    // Corrupt one slice: the group still reassembles to the right length, but
    // the tag no longer verifies, so the read fails loudly instead of yielding
    // a mangled value.
    const damaged = frames.map((f) => new Uint8Array(f));
    damaged[1][damaged[1].length - 1] ^= 0xff;
    await expect(readValues(damaged, key)).rejects.toThrow();
  });

  it('round-trips a sealed (cross-run) split write', async () => {
    const material = new Uint8Array(32).fill(0x5d);
    const ownerKeys = runPayloadKeys(
      await importKey(material),
      await deriveRunKeyPair(material)
    );
    const big = 'g'.repeat(4096);
    const frames = await writeFrames(
      [big],
      { splitChunks: true, maxChunkBytes: 1024 },
      sealTo(ownerKeys.keyPair.publicKey)
    );
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((f) => framePrefixOf(f) === SPLIT_PREFIX)).toBe(true);
    await expect(readValues(frames, ownerKeys)).resolves.toEqual([big]);
  });

  it('drops the incomplete group a mid-split read starts on and keeps later values', async () => {
    const big = 'h'.repeat(4096);
    const frames = await writeFrames(['first', big, 'last'], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    const splitFrames = frames.filter((f) => framePrefixOf(f) === SPLIT_PREFIX);
    expect(splitFrames.length).toBeGreaterThan(2);

    // A reader that resumed in the middle of the group: it sees the tail of
    // the split write, then the next whole write.
    const fromMidGroup = frames.slice(frames.indexOf(splitFrames[1]));
    await expect(readValues(fromMidGroup)).resolves.toEqual(['last']);
  });

  it('completes a group whose parts arrive over several transport reads', async () => {
    const big = 'i'.repeat(4096);
    const frames = await writeFrames([big], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    // One transport read carrying every frame at once, and another splitting a
    // frame across reads, must both produce the same single value.
    await expect(readValues([concat(frames)])).resolves.toEqual([big]);

    const joined = concat(frames);
    const halves = [joined.subarray(0, 37), joined.subarray(37)];
    await expect(readValues(halves)).resolves.toEqual([big]);
  });

  it('ends a stream cut mid-group without emitting a partial value', async () => {
    const frames = await writeFrames(['j'.repeat(4096)], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    await expect(readValues(frames.slice(0, -1))).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resume and reconnect
// ---------------------------------------------------------------------------

/** A stream whose `pull` replays a scripted sequence. */
function scriptedStream(
  steps: Array<
    | { kind: 'value'; value: Uint8Array }
    | { kind: 'error'; err: unknown }
    | { kind: 'close' }
  >
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const step = steps[i++];
      if (!step) return controller.close();
      if (step.kind === 'value') controller.enqueue(step.value);
      else if (step.kind === 'error') controller.error(step.err);
      else controller.close();
    },
  });
}

function makeWorld(
  scripts: Record<number, () => ReadableStream<Uint8Array>>,
  getInfo?: () => Promise<{ tailIndex: number; done: boolean }>
): { world: World; calls: number[] } {
  const calls: number[] = [];
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    streams: {
      get: vi.fn(async (_runId: string, _name: string, startIndex?: number) => {
        const idx = startIndex ?? 0;
        calls.push(idx);
        const factory = scripts[idx];
        if (!factory) throw new Error(`unexpected startIndex ${idx}`);
        return factory();
      }),
      ...(getInfo ? { getInfo: vi.fn(getInfo) } : {}),
    },
  } as unknown as World;
  return { world, calls };
}

describe('resume across split writes', () => {
  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  it('counts each continuation frame as one resume position', async () => {
    // Three writes: one small, one split into three parts, one small. Five
    // frames, so five stored chunks and five resume positions.
    const big = 'k'.repeat(2600);
    const frames = await writeFrames(['one', big, 'three'], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    expect(frames).toHaveLength(5);

    const { world, calls } = makeWorld({
      0: () =>
        scriptedStream([
          { kind: 'value', value: frames[0] },
          { kind: 'value', value: frames[1] },
          // Connection lost in the middle of the split group.
          { kind: 'error', err: new Error('connection reset') },
        ]),
      // The reconnect asks for the next frame, not the next logical write.
      2: () =>
        scriptedStream([
          { kind: 'value', value: frames[2] },
          { kind: 'value', value: frames[3] },
          { kind: 'value', value: frames[4] },
          { kind: 'close' },
        ]),
    });
    setWorld(world);

    const raw = await readAll(createReconnectingFramedStream(RUN_ID, 's', 0));
    expect(calls).toEqual([0, 2]);
    expect(raw).toHaveLength(5);

    // And the group interrupted by the reconnect still reassembles, because
    // the reassembler belongs to the reader session rather than a connection.
    await expect(readValues(raw)).resolves.toEqual(['one', big, 'three']);
  });

  it('treats an EOF inside a split group as incomplete and reconnects', async () => {
    const big = 'l'.repeat(2600);
    const frames = await writeFrames([big], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });
    expect(frames).toHaveLength(3);

    const { world, calls } = makeWorld(
      {
        0: () =>
          scriptedStream([
            { kind: 'value', value: frames[0] },
            { kind: 'close' },
          ]),
        1: () =>
          scriptedStream([
            { kind: 'value', value: frames[1] },
            { kind: 'value', value: frames[2] },
            { kind: 'close' },
          ]),
      },
      async () => ({ tailIndex: 2, done: true })
    );
    setWorld(world);

    const raw = await readAll(createReconnectingFramedStream(RUN_ID, 's', 0));
    expect(calls).toEqual([0, 1]);
    await expect(readValues(raw)).resolves.toEqual([big]);
  });

  it('resumes a read that starts on a continuation frame', async () => {
    const big = 'm'.repeat(2600);
    const frames = await writeFrames([big, 'after'], {
      splitChunks: true,
      maxChunkBytes: 1024,
    });

    const { world, calls } = makeWorld({
      // The caller asked for chunk 1, which is part 1 of a 3-part group.
      1: () =>
        scriptedStream([
          { kind: 'value', value: frames[1] },
          { kind: 'value', value: frames[2] },
          { kind: 'value', value: frames[3] },
          { kind: 'close' },
        ]),
    });
    setWorld(world);

    const raw = await readAll(createReconnectingFramedStream(RUN_ID, 's', 1));
    expect(calls).toEqual([1]);
    // The truncated group is dropped; the whole write after it survives.
    await expect(readValues(raw)).resolves.toEqual(['after']);
  });
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe('splitStreamChunks capability', () => {
  it('is off for runs whose core version is unknown or older', () => {
    expect(getRunCapabilities(undefined).splitStreamChunks).toBe(false);
    expect(getRunCapabilities('not-a-version').splitStreamChunks).toBe(false);
    expect(getRunCapabilities('5.2.3').splitStreamChunks).toBe(false);
  });

  it('is on from the release that ships the reassembling reader', () => {
    expect(getRunCapabilities('5.3.0').splitStreamChunks).toBe(true);
    expect(getRunCapabilities('6.0.0').splitStreamChunks).toBe(true);
  });
});

describe('part sizing', () => {
  it('accounts for every byte of wire overhead a part adds', async () => {
    // A part's frame is the length prefix, the format prefix, the
    // continuation header, and the slice. If SPLIT_PART_OVERHEAD_BYTES were
    // wrong, a maximally sized part would exceed the cap it was sized against.
    const frames = await writeFrames(['n'.repeat(100_000)], {
      splitChunks: true,
      maxChunkBytes: 4096,
    });
    const full = frames.slice(0, -1);
    expect(full.length).toBeGreaterThan(1);
    for (const frame of full) {
      expect(frame.byteLength).toBe(4096);
    }
    expect(SPLIT_PART_OVERHEAD_BYTES).toBe(
      FRAME_HEADER_SIZE + 4 + SPLIT_HEADER_SIZE
    );
  });
});
