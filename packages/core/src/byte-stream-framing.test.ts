import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWorld } from './runtime/world.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  getByteFramingStream,
  getByteUnframingStream,
} from './serialization.js';

const FRAME_HEADER_SIZE = 4;

/** Big-endian uint32 length prefix. */
function header(length: number): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_SIZE);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Builds a ReadableStream<Uint8Array> from a fixed list of chunks. Each
 * chunk is enqueued in its own `pull` call, so the consumer can observe
 * read boundaries (important for the unframer's split-frame tests).
 */
function readableFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
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

describe('getByteFramingStream', () => {
  it('wraps each chunk in a 4-byte big-endian length prefix', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ];
    const framed = await readAll(
      readableFromChunks(chunks).pipeThrough(getByteFramingStream())
    );

    expect(framed).toHaveLength(3);
    expect(framed[0]).toEqual(concat(header(3), new Uint8Array([1, 2, 3])));
    expect(framed[1]).toEqual(concat(header(2), new Uint8Array([4, 5])));
    expect(framed[2]).toEqual(concat(header(1), new Uint8Array([6])));
  });

  it('drops empty chunks', async () => {
    // Empty frames would encode as `[0x00 0x00 0x00 0x00]`, which would
    // collide with the legacy "looks framed" sniff in
    // `getDeserializeStream`. They also carry no information, so we
    // drop them on the writer side.
    const framed = await readAll(
      readableFromChunks([
        new Uint8Array([1]),
        new Uint8Array(0),
        new Uint8Array([2]),
      ]).pipeThrough(getByteFramingStream())
    );

    expect(framed).toHaveLength(2);
    expect(framed[0]).toEqual(concat(header(1), new Uint8Array([1])));
    expect(framed[1]).toEqual(concat(header(1), new Uint8Array([2])));
  });

  it('handles a large chunk', async () => {
    const big = new Uint8Array(64_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;

    const framed = await readAll(
      readableFromChunks([big]).pipeThrough(getByteFramingStream())
    );

    expect(framed).toHaveLength(1);
    expect(framed[0].length).toBe(FRAME_HEADER_SIZE + big.length);
    // Header decodes to the chunk length
    expect(new DataView(framed[0].buffer).getUint32(0, false)).toBe(big.length);
    // Payload is preserved verbatim
    expect(framed[0].slice(FRAME_HEADER_SIZE)).toEqual(big);
  });

  it('handles a stream with no chunks (clean EOF)', async () => {
    const framed = await readAll(
      readableFromChunks([]).pipeThrough(getByteFramingStream())
    );
    expect(framed).toHaveLength(0);
  });

  it('errors at write time on a chunk larger than the frame size cap', async () => {
    // The framer enforces the same MAX_FRAME_SIZE the unframer checks, so
    // an oversized chunk fails loudly at the producer (where the error is
    // actionable) instead of encoding a frame the consumer can never
    // decode. One byte past the 100MB cap; zero-filled allocation is cheap.
    const oversized = new Uint8Array(100_000_001);
    await expect(
      readAll(
        readableFromChunks([oversized]).pipeThrough(getByteFramingStream())
      )
    ).rejects.toThrow(/exceeds the maximum framed chunk size/);
  });
});

describe('getByteUnframingStream', () => {
  it('round-trips through the framer', async () => {
    const chunks = [
      new TextEncoder().encode('hello'),
      new TextEncoder().encode(', '),
      new TextEncoder().encode('world'),
    ];

    const result = await readAll(
      readableFromChunks(chunks)
        .pipeThrough(getByteFramingStream())
        .pipeThrough(getByteUnframingStream())
    );

    expect(result).toEqual(chunks);
  });

  it('reassembles a frame split across multiple reads', async () => {
    // Frame: header(5) + 'hello'. Deliver byte-by-byte to prove the
    // unframer buffers across read boundaries.
    const full = concat(header(5), new TextEncoder().encode('hello'));
    const split = Array.from(full).map((b) => new Uint8Array([b]));

    const result = await readAll(
      readableFromChunks(split).pipeThrough(getByteUnframingStream())
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(new TextEncoder().encode('hello'));
  });

  it('emits multiple frames coalesced into a single read', async () => {
    // Three frames glued together in one transport chunk — the unframer
    // should split them out.
    const big = concat(
      header(3),
      new Uint8Array([1, 2, 3]),
      header(2),
      new Uint8Array([4, 5]),
      header(1),
      new Uint8Array([6])
    );

    const result = await readAll(
      readableFromChunks([big]).pipeThrough(getByteUnframingStream())
    );

    expect(result).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ]);
  });

  it('errors if the stream ends mid-frame', async () => {
    // Header advertises a 5-byte payload but only 2 bytes follow.
    const truncated = concat(header(5), new Uint8Array([1, 2]));

    await expect(
      readAll(
        readableFromChunks([truncated]).pipeThrough(getByteUnframingStream())
      )
    ).rejects.toThrow(/truncated/i);
  });

  it('errors on a frame larger than the safety cap', async () => {
    // 200MB length advertised — well past the 100MB cap. Ensures we
    // fail fast instead of allocating an enormous buffer when fed a
    // non-framed wire (e.g. a raw byte stream routed to a framed reader).
    const bogus = concat(header(200_000_000), new Uint8Array([1, 2, 3]));

    await expect(
      readAll(readableFromChunks([bogus]).pipeThrough(getByteUnframingStream()))
    ).rejects.toThrow(/exceeds maximum/i);
  });

  it('treats clean EOF with no buffered data as success', async () => {
    const result = await readAll(
      readableFromChunks([]).pipeThrough(getByteUnframingStream())
    );
    expect(result).toHaveLength(0);
  });

  it('preserves chunk identity across many small reads', async () => {
    // 100 single-byte chunks → 100 single-byte frames → after round-trip,
    // 100 single-byte chunks emerge in the same order.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) chunks.push(new Uint8Array([i]));

    const result = await readAll(
      readableFromChunks(chunks)
        .pipeThrough(getByteFramingStream())
        .pipeThrough(getByteUnframingStream())
    );

    expect(result).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(result[i]).toEqual(new Uint8Array([i]));
    }
  });
});

// ----------------------------------------------------------------------------
// framed-v2: per-writer markers for the single-request streaming writer.
// ----------------------------------------------------------------------------

describe('framed-v2 byte framing', () => {
  const WRITER_ID_SIZE = 8;
  const FRAME_MARKER_SIZE = WRITER_ID_SIZE + 8;

  function writerId(seed: number): Uint8Array {
    const id = new Uint8Array(WRITER_ID_SIZE);
    id[0] = seed;
    return id;
  }

  it('round-trips payloads and strips the marker', async () => {
    const id = writerId(0xab);
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ];
    const result = await readAll(
      readableFromChunks(chunks)
        .pipeThrough(getByteFramingStream(id))
        .pipeThrough(getByteUnframingStream('framed-v2'))
    );
    expect(result).toEqual(chunks);
  });

  it('frames carry a parseable marker with a monotonic per-writer seq', async () => {
    const id = writerId(0x07);
    const frames = await readAll(
      readableFromChunks([
        new Uint8Array([10]),
        new Uint8Array([20]),
        new Uint8Array([30]),
      ]).pipeThrough(getByteFramingStream(id))
    );
    frames.forEach((frame, i) => {
      const view = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength
      );
      const frameLength = view.getUint32(0, false);
      expect(frameLength).toBe(FRAME_MARKER_SIZE + 1);
      // writerId occupies the bytes right after the 4-byte length prefix.
      expect(frame[FRAME_HEADER_SIZE]).toBe(0x07);
      // seq is the 8-byte big-endian uint64 after the writerId.
      const seq = view.getBigUint64(FRAME_HEADER_SIZE + WRITER_ID_SIZE, false);
      expect(seq).toBe(BigInt(i));
    });
  });

  it('dedupes a replayed frame (same writerId + seq) on the read side', async () => {
    // One writer frames chunks 0..3 in order (seq 0..3). Recovery re-sends
    // already-persisted frames 1 and 2 verbatim before the new frame 3, so the
    // stored tail the reader sees is: 0,1,2, 1,2, 3.
    const id = writerId(0x42);
    const [f0, f1, f2, f3] = await readAll(
      readableFromChunks([
        new Uint8Array([0]),
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3]),
      ]).pipeThrough(getByteFramingStream(id))
    );

    const delivered = await readAll(
      readableFromChunks([f0, f1, f2, f1, f2, f3]).pipeThrough(
        getByteUnframingStream('framed-v2')
      )
    );

    // Replays (seq 1, 2) are dropped; 0,1,2,3 each delivered exactly once.
    expect(delivered).toEqual([
      new Uint8Array([0]),
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
  });

  it('keeps interleaved frames from two writers apart (per-writer dedupe)', async () => {
    // Concurrent writers on one stream are documented behavior — and a
    // crashed invocation's writer (A) can interleave with its retry's
    // writer (B). Seq spaces are per-writer: B's seq 0/1 must not collide
    // with A's, and a replay of A's frame after B started is still deduped.
    const idA = writerId(0xa1);
    const idB = writerId(0xb2);
    const [a0, a1] = await readAll(
      readableFromChunks([
        new Uint8Array([10]),
        new Uint8Array([11]),
      ]).pipeThrough(getByteFramingStream(idA))
    );
    const [b0, b1] = await readAll(
      readableFromChunks([
        new Uint8Array([20]),
        new Uint8Array([21]),
      ]).pipeThrough(getByteFramingStream(idB))
    );

    const delivered = await readAll(
      readableFromChunks([a0, b0, a1, a1, b1]).pipeThrough(
        getByteUnframingStream('framed-v2')
      )
    );

    // Every unique frame from both writers delivered exactly once, in
    // arrival order; only A's replayed frame is dropped.
    expect(delivered).toEqual([
      new Uint8Array([10]),
      new Uint8Array([20]),
      new Uint8Array([11]),
      new Uint8Array([21]),
    ]);
  });

  it('errors on a framed-v2 frame too small to hold a marker', async () => {
    // A framed-v1-shaped frame (no marker) read as framed-v2 must be rejected
    // rather than silently mis-stripping payload bytes as a marker.
    const tooSmall = concat(header(2), new Uint8Array([0xaa, 0xbb]));
    await expect(
      readAll(
        readableFromChunks([tooSmall]).pipeThrough(
          getByteUnframingStream('framed-v2')
        )
      )
    ).rejects.toThrow(/smaller than the .*writer marker/);
  });
});

// ----------------------------------------------------------------------------
// End-to-end: dehydrate + hydrate carries the framing decision through the
// stream ref, and round-trips byte data correctly in both modes.
// ----------------------------------------------------------------------------

/**
 * In-memory mock world that captures stream writes and replays them on
 * subsequent reads. Just enough surface for the dehydrate/hydrate paths
 * exercised below — no event log, no queue, etc.
 */
function makeMockWorld(): World {
  const streamData = new Map<string, Uint8Array[]>();
  const closedStreams = new Set<string>();

  const write = vi.fn(
    async (
      _runId: string | Promise<string>,
      name: string,
      chunk: string | Uint8Array
    ) => {
      const list = streamData.get(name) ?? [];
      // Copy bytes — byte-stream pipes transfer ArrayBuffer ownership,
      // so the source buffer may be detached by the time the test
      // wants to compare it to expected values.
      const stored =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : new Uint8Array(chunk);
      list.push(stored);
      streamData.set(name, list);
    }
  );

  return {
    specVersion: SPEC_VERSION_CURRENT,
    streams: {
      write,
      writeMulti: vi.fn(
        async (
          _runId: string | Promise<string>,
          name: string,
          chunks: (string | Uint8Array)[]
        ) => {
          for (const chunk of chunks) {
            await write(_runId, name, chunk);
          }
        }
      ),
      get: vi.fn(async (_runId: string, name: string) => {
        const chunks = streamData.get(name) ?? [];
        let i = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < chunks.length) {
              controller.enqueue(chunks[i++]);
            } else {
              controller.close();
            }
          },
        });
      }),
      close: vi.fn(async (_runId: string | Promise<string>, name: string) => {
        closedStreams.add(name);
      }),
    },
  } as unknown as World;
}

describe('byte-stream framing end-to-end through dehydrate/hydrate', () => {
  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  async function readBytes(
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

  it('emits no `framing` field when framedByteStreams is false (back-compat)', async () => {
    setWorld(makeMockWorld());
    const stream = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });

    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateWorkflowArguments(
      stream,
      'wrun_test',
      undefined,
      ops,
      globalThis,
      false,
      // framedByteStreams = false — legacy raw bytes
      false
    );
    await Promise.all(ops);

    // The serialized devalue blob should reference a ReadableStream with
    // no `framing` field (treated as raw on the consumer side).
    expect(dehydrated).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(dehydrated as Uint8Array);
    expect(text).toContain('ReadableStream');
    expect(text).not.toContain('framing');
    expect(text).not.toContain('framed-v1');
  });

  it('emits `framing: framed-v1` when framedByteStreams is true', async () => {
    setWorld(makeMockWorld());
    const stream = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });

    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateWorkflowArguments(
      stream,
      'wrun_test',
      undefined,
      ops,
      globalThis,
      false,
      true
    );
    await Promise.all(ops);

    expect(dehydrated).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(dehydrated as Uint8Array);
    expect(text).toContain('framed-v1');
  });

  /**
   * Pull the auto-generated stream name out of a devalue-serialized
   * blob. Devalue uses index references rather than nested object
   * literals, so the `name` field shows up as a flat string somewhere
   * in the array. We just match the ULID pattern, which is unique
   * enough that it can't conflict with anything else devalue might
   * emit.
   */
  function extractStreamName(dehydrated: Uint8Array): string {
    const text = new TextDecoder().decode(dehydrated);
    const m = text.match(/strm_[0-9A-HJKMNP-TV-Z]{26}/);
    if (!m) {
      throw new Error(
        `Could not find strm_<ULID> in serialized payload: ${text.slice(0, 200)}`
      );
    }
    return m[0];
  }

  it('round-trips a framed byte stream: producer writes framed, consumer unframes', async () => {
    setWorld(makeMockWorld());

    const original = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    // Snapshot for comparison since byte-stream pipes detach the source.
    const expected = original.map((u) => new Uint8Array(u));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(c) {
        if (i < original.length) {
          c.enqueue(original[i++]);
        } else {
          c.close();
        }
      },
    });

    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateStepReturnValue(
      stream,
      'wrun_test',
      undefined,
      ops,
      globalThis,
      false,
      true
    );
    // Wait for the producer pipe to finish writing all chunks to the world.
    await Promise.all(ops);

    // Sanity: the wire format is framed.
    const text = new TextDecoder().decode(dehydrated as Uint8Array);
    expect(text).toContain('framed-v1');

    // Replay the bytes the world has captured into a fresh ReadableStream
    // and pipe through the unframer — this is exactly what
    // `getExternalRevivers` does for `framing === 'framed-v1'` refs.
    const name = extractStreamName(dehydrated as Uint8Array);
    const world = await (await import('./runtime/world.js')).getWorld();
    const wireStream = await world.streams.get('wrun_test', name);
    const userBytes = await readBytes(
      wireStream.pipeThrough(getByteUnframingStream())
    );

    expect(userBytes).toEqual(expected);
  });

  it('round-trips a framed-v2 byte stream: frames carry per-writer markers that the unframer strips', async () => {
    setWorld(makeMockWorld());
    const { readFrameMarker } = await import('./serialization/frame-marker.js');

    const original = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const expected = original.map((u) => new Uint8Array(u));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(c) {
        if (i < original.length) {
          c.enqueue(original[i++]);
        } else {
          c.close();
        }
      },
    });

    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateStepReturnValue(
      stream,
      'wrun_test',
      undefined,
      ops,
      globalThis,
      false,
      true,
      false,
      undefined,
      // framedStreamMarkers: the target run can decode framed-v2
      true
    );
    await Promise.all(ops);

    // The ref records framed-v2, so the consumer picks the marker-stripping
    // unframer.
    const text = new TextDecoder().decode(dehydrated as Uint8Array);
    expect(text).toContain('framed-v2');

    const name = extractStreamName(dehydrated as Uint8Array);
    const world = await (await import('./runtime/world.js')).getWorld();

    // Every wire frame carries the same writerId with increasing seq.
    const wire = await readBytes(await world.streams.get('wrun_test', name));
    const markers = wire.map((f) =>
      readFrameMarker(f.subarray(FRAME_HEADER_SIZE))
    );
    expect(markers[0].writerId).toEqual(markers[1].writerId);
    expect(markers.map((m) => m.seq)).toEqual([0n, 1n]);

    // The framed-v2 unframer strips the markers — and drops a frame the
    // write transport resent (duplicate writerId+seq) instead of delivering
    // it twice.
    const replayed = [...wire, wire[wire.length - 1]];
    const got = await readBytes(
      readableFromChunks(replayed).pipeThrough(
        getByteUnframingStream('framed-v2')
      )
    );
    expect(got).toEqual(expected);
  });

  it('round-trips a raw byte stream: producer writes raw, consumer reads raw', async () => {
    setWorld(makeMockWorld());

    const original = [new Uint8Array([10, 20, 30])];
    const expected = original.map((u) => new Uint8Array(u));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(c) {
        if (i < original.length) {
          c.enqueue(original[i++]);
        } else {
          c.close();
        }
      },
    });

    const ops: Promise<void>[] = [];
    const dehydrated = await dehydrateStepReturnValue(
      stream,
      'wrun_test',
      undefined,
      ops,
      globalThis,
      false,
      false
    );
    await Promise.all(ops);

    const text = new TextDecoder().decode(dehydrated as Uint8Array);
    expect(text).not.toContain('framed-v1');

    // Sanity: the world has the raw user bytes as written, without any
    // length-prefix envelope. (The reviver-side dispatch on absent
    // `framing` is exercised by the existing serialization tests in
    // serialization.test.ts; here we just confirm the wire bytes match
    // what the user wrote.)
    const name = extractStreamName(dehydrated as Uint8Array);
    const world = await (await import('./runtime/world.js')).getWorld();
    const wireStream = await world.streams.get('wrun_test', name);
    const wireBytes = await readBytes(wireStream);
    // Single chunk, no framing — just the user bytes.
    expect(wireBytes).toEqual(expected);
  });

  it('framer output written chunk-by-chunk to a world stream unframes back to the original chunks', async () => {
    // Wire-level round-trip through a world stream: frame user chunks,
    // persist each frame as its own stored chunk (the one-frame-per-chunk
    // invariant documented on getByteFramingStream), then read back and
    // unframe. The reviver's ref-based dispatch (framed-v1 → unframe,
    // absent → raw) is covered end-to-end by the two round-trip tests
    // above, which go through dehydrateStepReturnValue and assert the
    // serialized ref contents.
    setWorld(makeMockWorld());
    const world = await (await import('./runtime/world.js')).getWorld();

    // Frame three user chunks into the wire format and stash them.
    const chunks = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
      new Uint8Array([6]),
    ];
    const reader = new ReadableStream<Uint8Array>({
      pull(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    })
      .pipeThrough(getByteFramingStream())
      .getReader();

    const wireBytes: Uint8Array[] = [];
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      wireBytes.push(r.value);
    }
    for (const b of wireBytes) {
      await world.streams.write('wrun_test', 'strm_known', b);
    }

    // Now read back via wire stream + unframer — should produce original chunks.
    const wireStream = await world.streams.get('wrun_test', 'strm_known');
    const got = await readBytes(
      wireStream.pipeThrough(getByteUnframingStream())
    );
    expect(got).toEqual(chunks);
  });
});
