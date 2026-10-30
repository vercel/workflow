import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

import { getSerializeStream } from '../serialization.js';
import { getWorldLazy } from './get-world-lazy.js';
import { getRun } from './run.js';

const RUN_ID = 'wrun_position';

/** The wire frames a producer writes for `values`, split at `maxChunkBytes`. */
async function framesFor(
  values: unknown[],
  maxChunkBytes?: number
): Promise<Uint8Array[]> {
  const serialize = getSerializeStream(
    {},
    undefined,
    maxChunkBytes === undefined ? {} : { splitChunks: true, maxChunkBytes }
  );
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
  for (const value of values) await writer.write(value);
  await writer.close();
  await read;
  return frames;
}

function mockWorld(frames: Uint8Array[]) {
  const get = vi.fn(async () => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < frames.length) controller.enqueue(frames[i++]);
        else controller.close();
      },
    });
  });
  vi.mocked(getWorldLazy).mockReturnValue({
    runs: { get: vi.fn().mockResolvedValue({ runId: RUN_ID }) },
    streams: {
      get,
      getInfo: vi.fn().mockResolvedValue({
        tailIndex: frames.length - 1,
        done: true,
      }),
    },
  } as never);
  return { get };
}

/** Reads every value, recording the stream position after each. */
async function readWithPositions(
  stream: ReadableStream<unknown> & { readonly position: number | undefined }
): Promise<{ value: unknown; position: number | undefined }[]> {
  const reader = stream.getReader();
  const out: { value: unknown; position: number | undefined }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push({ value, position: stream.position });
  }
  return out;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Run#getReadable position', () => {
  it('reports the chunk index each value ended on', async () => {
    mockWorld(await framesFor(['a', 'b', 'c']));
    const readable = getRun(RUN_ID).getReadable<string>({ startIndex: 0 });

    expect(readable.position).toBe(-1);
    expect(await readWithPositions(readable)).toEqual([
      { value: 'a', position: 0 },
      { value: 'b', position: 1 },
      { value: 'c', position: 2 },
    ]);
  });

  it('counts the chunks a split write occupied, not one per value', async () => {
    // The reason a resumable consumer needs this at all: 'big' is stored
    // across several chunks, so a count of delivered values would resume
    // behind it and replay everything after it.
    const big = 'x'.repeat(4096);
    const frames = await framesFor(['a', big, 'b'], 1024);
    expect(frames.length).toBeGreaterThan(3);
    mockWorld(frames);

    const readable = getRun(RUN_ID).getReadable<string>({ startIndex: 0 });
    const read = await readWithPositions(readable);

    expect(read.map((r) => r.value)).toEqual(['a', big, 'b']);
    expect(read[0].position).toBe(0);
    // 'big' ends on the last of its continuation chunks.
    expect(read[1].position).toBe(frames.length - 2);
    expect(read[2].position).toBe(frames.length - 1);
    // And `position + 1` is exactly the next read's startIndex.
    expect(read.at(-1)?.position).toBe(frames.length - 1);
  });

  it('anchors positions to the startIndex it read from', async () => {
    mockWorld(await framesFor(['d', 'e']));
    const readable = getRun(RUN_ID).getReadable<string>({ startIndex: 7 });

    expect(readable.position).toBe(6);
    expect(await readWithPositions(readable)).toEqual([
      { value: 'd', position: 7 },
      { value: 'e', position: 8 },
    ]);
  });

  it('reports no position for a negative startIndex, which the server resolves', async () => {
    mockWorld(await framesFor(['f']));
    const readable = getRun(RUN_ID).getReadable<string>({ startIndex: -1 });

    expect(readable.position).toBeUndefined();
    const read = await readWithPositions(readable);
    expect(read.map((r) => r.value)).toEqual(['f']);
    expect(read[0].position).toBeUndefined();
  });
});
