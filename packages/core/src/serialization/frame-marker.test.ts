import { describe, expect, it } from 'vitest';
import {
  buildFramedV2Frame,
  FRAME_HEADER_SIZE,
  FRAME_MARKER_SIZE,
  readFrameMarker,
  WRITER_ID_SIZE,
  writerIdKey,
} from './frame-marker.js';

function writerId(...bytes: number[]): Uint8Array {
  const id = new Uint8Array(WRITER_ID_SIZE);
  id.set(bytes);
  return id;
}

describe('framed-v2 frame marker', () => {
  it('round-trips writerId, seq, and inner payload', () => {
    const id = writerId(1, 2, 3, 4, 5, 6, 7, 8);
    const inner = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const frame = buildFramedV2Frame(inner, { writerId: id, seq: 42n });

    // Frame length prefix counts marker + inner.
    const declaredLen = new DataView(
      frame.buffer,
      frame.byteOffset,
      frame.byteLength
    ).getUint32(0, false);
    expect(declaredLen).toBe(FRAME_MARKER_SIZE + inner.length);
    expect(frame.length).toBe(FRAME_HEADER_SIZE + declaredLen);

    const body = frame.subarray(FRAME_HEADER_SIZE);
    const marker = readFrameMarker(body);
    expect(Array.from(marker.writerId)).toEqual(Array.from(id));
    expect(marker.seq).toBe(42n);

    const recoveredInner = body.subarray(FRAME_MARKER_SIZE);
    expect(Array.from(recoveredInner)).toEqual(Array.from(inner));
  });

  it('handles seq 0 and a large 64-bit seq', () => {
    const id = writerId(0xff);
    for (const seq of [0n, 1n, 2n ** 53n, 2n ** 64n - 1n]) {
      const frame = buildFramedV2Frame(new Uint8Array(0), {
        writerId: id,
        seq,
      });
      const marker = readFrameMarker(frame.subarray(FRAME_HEADER_SIZE));
      expect(marker.seq).toBe(seq);
    }
  });

  it('reads a marker correctly when the frame is a view into a larger buffer', () => {
    const id = writerId(9, 8, 7, 6, 5, 4, 3, 2);
    const inner = new Uint8Array([1, 2, 3]);
    const frame = buildFramedV2Frame(inner, { writerId: id, seq: 7n });

    // Embed the frame mid-way through a larger backing buffer to exercise
    // byteOffset arithmetic in readFrameMarker.
    const backing = new Uint8Array(frame.length + 11);
    backing.set(frame, 5);
    const view = backing.subarray(5, 5 + frame.length);

    const marker = readFrameMarker(view.subarray(FRAME_HEADER_SIZE));
    expect(Array.from(marker.writerId)).toEqual(Array.from(id));
    expect(marker.seq).toBe(7n);
  });

  it('rejects a writerId of the wrong size', () => {
    expect(() =>
      buildFramedV2Frame(new Uint8Array(0), {
        writerId: new Uint8Array(4),
        seq: 0n,
      })
    ).toThrow(/writerId must be 8 bytes/);
  });

  it('produces stable, distinct hex keys', () => {
    expect(writerIdKey(writerId(0x0a, 0x0b))).toBe('0a0b000000000000');
    expect(writerIdKey(writerId(1))).not.toBe(writerIdKey(writerId(2)));
  });
});
