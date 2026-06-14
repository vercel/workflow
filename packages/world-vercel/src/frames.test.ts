import { decode, encode } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import {
  type DecodedFrame,
  decodeFrames,
  encodeFrame,
  V4_FRAME_CONTENT_TYPE,
} from './frames.js';

/** Server's wire encoder (matches the world-vercel backend's v4 end-frame
 *  helper). Re-implemented here so the client tests don't depend on
 *  importing from another package. */
function encodeEndFrame(next?: string): Uint8Array {
  const meta: Record<string, unknown> = { _end: 1 };
  if (next) meta.next = next;
  return encodeFrame(meta, new Uint8Array(0));
}

/** Build a ReadableStream that yields `payload` in fixed-size chunks. Used to
 *  stress chunk-boundary handling in the decoder. */
function streamOf(payload: Uint8Array, chunkSize: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, payload.byteLength);
      controller.enqueue(payload.subarray(offset, end));
      offset = end;
    },
  });
}

async function drainFrames(
  source: ReadableStream<Uint8Array>
): Promise<DecodedFrame[]> {
  const out: DecodedFrame[] = [];
  for await (const f of decodeFrames(source)) out.push(f);
  return out;
}

describe('encodeFrame', () => {
  it('produces the canonical wire layout', () => {
    const meta = { eventId: 'evnt_abc', n: 42 };
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeFrame(meta, body);
    const view = new DataView(frame.buffer);
    const metaLen = view.getUint32(0, false);
    expect(decode(frame.subarray(4, 4 + metaLen))).toEqual(meta);
    const bodyLen = view.getUint32(4 + metaLen, false);
    expect(bodyLen).toBe(body.byteLength);
    expect(frame.subarray(4 + metaLen + 4)).toEqual(body);
  });
});

describe('decodeFrames', () => {
  it('round-trips a single frame', async () => {
    const meta = { eventType: 'run_created', eventId: 'evnt_1' };
    const body = new TextEncoder().encode('{"hello":"world"}');
    const stream = streamOf(
      new Uint8Array([...encodeFrame(meta, body), ...encodeEndFrame()]),
      4096
    );
    const frames = await drainFrames(stream);
    expect(frames).toHaveLength(2);
    expect(frames[0].meta).toEqual(meta);
    expect(frames[0].body).toEqual(body);
    expect(frames[1].meta).toEqual({ _end: 1 });
  });

  it('round-trips multiple frames with cursor', async () => {
    const body1 = new TextEncoder().encode('one');
    const body2 = new Uint8Array(64).fill(0xab);
    const parts = [
      encodeFrame({ eventId: 'a' }, body1),
      encodeFrame({ eventId: 'b' }, body2),
      encodeEndFrame('cursor-xyz'),
    ];
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const flat = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      flat.set(p, off);
      off += p.byteLength;
    }
    const frames = await drainFrames(streamOf(flat, 256));
    expect(frames).toHaveLength(3);
    expect(frames[0].meta).toEqual({ eventId: 'a' });
    expect(frames[0].body).toEqual(body1);
    expect(frames[1].meta).toEqual({ eventId: 'b' });
    expect(frames[1].body).toEqual(body2);
    expect(frames[2].meta).toEqual({ _end: 1, next: 'cursor-xyz' });
    expect(frames[2].body.byteLength).toBe(0);
  });

  it('handles delivery in 1-byte chunks (worst-case chunk boundary)', async () => {
    const body = new Uint8Array(1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 13 + 5) & 0xff;
    const flat = new Uint8Array([
      ...encodeFrame({ eventType: 'big', n: 99 }, body),
      ...encodeEndFrame(),
    ]);
    const frames = await drainFrames(streamOf(flat, 1));
    expect(frames).toHaveLength(2);
    expect(frames[0].meta).toEqual({ eventType: 'big', n: 99 });
    expect(frames[0].body).toEqual(body);
    expect(frames[1].meta).toEqual({ _end: 1 });
  });

  it('handles a 64 KB body split across many small chunks', async () => {
    const body = new Uint8Array(64 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
    const flat = new Uint8Array([
      ...encodeFrame({ eventId: 'big' }, body),
      ...encodeEndFrame(),
    ]);
    const frames = await drainFrames(streamOf(flat, 37));
    expect(frames[0].body.byteLength).toBe(body.byteLength);
    expect(frames[0].body[0]).toBe(body[0]);
    expect(frames[0].body[body.length - 1]).toBe(body[body.length - 1]);
  });

  it('handles frames whose body contains bytes that look like length prefixes', async () => {
    // 0xff bytes that could trip up a parser that scans for u32 patterns
    // rather than honoring the explicit length prefixes.
    const body = new Uint8Array(32).fill(0xff);
    const flat = new Uint8Array([
      ...encodeFrame({ eventId: 'tricky' }, body),
      ...encodeEndFrame(),
    ]);
    const frames = await drainFrames(streamOf(flat, 7));
    expect(frames[0].body).toEqual(body);
  });

  it('handles back-to-back frames in a single chunk', async () => {
    const flat = new Uint8Array([
      ...encodeFrame({ id: 1 }, new Uint8Array([10, 20, 30])),
      ...encodeFrame({ id: 2 }, new Uint8Array([40, 50, 60])),
      ...encodeFrame({ id: 3 }, new Uint8Array(0)),
      ...encodeEndFrame(),
    ]);
    const frames = await drainFrames(streamOf(flat, flat.byteLength));
    expect(frames).toHaveLength(4);
    expect(frames[2].body.byteLength).toBe(0);
    expect(frames[3].meta._end).toBe(1);
  });

  it('throws when the stream ends mid-frame', async () => {
    const partial = encodeFrame({ x: 1 }, new Uint8Array(100)).slice(0, 20);
    const stream = streamOf(partial, 1024);
    await expect(drainFrames(stream)).rejects.toThrow(/truncated/);
  });

  it('preserves CBOR types in meta (numbers, booleans, arrays)', async () => {
    const meta = {
      eventId: 'mix',
      attempt: 4,
      isWebhook: true,
      tags: ['a', 'b'],
      n: 12345,
    };
    const flat = new Uint8Array([
      ...encodeFrame(meta, new Uint8Array(0)),
      ...encodeEndFrame(),
    ]);
    const frames = await drainFrames(streamOf(flat, 32));
    expect(frames[0].meta).toEqual(meta);
    expect(typeof frames[0].meta.attempt).toBe('number');
    expect(typeof frames[0].meta.isWebhook).toBe('boolean');
    expect(Array.isArray(frames[0].meta.tags)).toBe(true);
  });
});

describe('decodeFrames from an AsyncIterable source', () => {
  // Regression guard: production feeds undici's response body (an
  // AsyncIterable of Buffer chunks) into decodeFrames directly. The
  // previous node:stream Readable.toWeb conversion crashed in Next.js
  // webpack server bundles (`(await import('node:stream')).Readable` is
  // undefined there), so the decoder must not require a Web stream.
  async function* chunked(payload: Uint8Array, chunkSize: number) {
    for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
      // Yield Buffer (not Uint8Array) chunks, like undici does.
      yield Buffer.from(
        payload.subarray(
          offset,
          Math.min(offset + chunkSize, payload.byteLength)
        )
      );
    }
  }

  it('round-trips frames from an async generator of Buffer chunks', async () => {
    const body = new Uint8Array([9, 8, 7]);
    const flat = new Uint8Array([
      ...encodeFrame({ eventId: 'evnt_1', eventType: 'run_created' }, body),
      ...encodeEndFrame('cursor-1'),
    ]);
    const frames: DecodedFrame[] = [];
    for await (const f of decodeFrames(chunked(flat, 3))) frames.push(f);
    expect(frames).toHaveLength(2);
    expect(frames[0].meta).toEqual({
      eventId: 'evnt_1',
      eventType: 'run_created',
    });
    expect(frames[0].body).toEqual(body);
    expect(frames[1].meta).toEqual({ _end: 1, next: 'cursor-1' });
  });
});

describe('V4_FRAME_CONTENT_TYPE', () => {
  it('matches the server-side content type', () => {
    expect(V4_FRAME_CONTENT_TYPE).toBe('application/vnd.workflow.v4-frames');
  });
});
