/**
 * Length-prefixed binary frame codec for the v4 list-events response.
 *
 * Mirrors the server-side encoder in the world-vercel backend. Wire format:
 *
 *   list-response := frame*  end-frame
 *   frame         := u32_be(meta_len) || cbor_meta || u32_be(body_len) || body_bytes
 *   end-frame     := u32_be(meta_len) || cbor_meta {_end: 1, next?: string} || u32_be(0)
 */

import { decode, encode } from 'cbor-x';

export const V4_FRAME_CONTENT_TYPE = 'application/vnd.workflow.v4-frames';

export interface DecodedFrame {
  meta: Record<string, unknown>;
  body: Uint8Array;
}

/** Test/utility: encode a complete frame. Production server uses prefix
 *  + streaming body. */
export function encodeFrame(
  meta: Record<string, unknown>,
  body: Uint8Array
): Uint8Array {
  const metaBytes = new Uint8Array(encode(meta));
  const out = new Uint8Array(4 + metaBytes.byteLength + 4 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, metaBytes.byteLength, false);
  out.set(metaBytes, 4);
  view.setUint32(4 + metaBytes.byteLength, body.byteLength, false);
  out.set(body, 4 + metaBytes.byteLength + 4);
  return out;
}

/**
 * Async-iterable parser for a frame stream. Yields one `DecodedFrame`
 * per frame in source order, terminating at the sentinel frame whose
 * meta contains `_end: 1`. The sentinel frame itself IS yielded — the
 * caller inspects `meta._end` to detect end-of-stream and reads
 * `meta.next` for the pagination cursor.
 *
 * Accepts any async iterable of byte chunks (undici response bodies,
 * Node Readables) as well as a Web ReadableStream. Notably it must NOT
 * require a `node:stream` conversion: `Readable.toWeb` via dynamic
 * `import('node:stream')` resolves to an empty namespace in Next.js
 * webpack server bundles and crashes at runtime.
 *
 * Survives arbitrary chunk boundaries from the source stream, including
 * splits that fall in the middle of a u32 length prefix or in the
 * middle of the CBOR meta block.
 */
export async function* decodeFrames(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
): AsyncGenerator<DecodedFrame> {
  const chunks =
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : readerToIterator((source as ReadableStream<Uint8Array>).getReader());
  // Accumulating buffer of bytes we've read but not yet consumed.
  let buffer = new Uint8Array(0);

  const refill = async (needed: number): Promise<boolean> => {
    while (buffer.byteLength < needed) {
      const { done, value } = await chunks.next();
      if (done) return false;
      if (!value || value.byteLength === 0) continue;
      const next = new Uint8Array(buffer.byteLength + value.byteLength);
      next.set(buffer, 0);
      next.set(value, buffer.byteLength);
      buffer = next;
    }
    return true;
  };

  const take = (n: number): Uint8Array => {
    const out = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    return out;
  };

  while (true) {
    if (!(await refill(4))) return;
    const metaLen = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(
      0,
      false
    );
    take(4);

    if (!(await refill(metaLen))) {
      throw new Error('decodeFrames: truncated meta block');
    }
    const meta = decode(take(metaLen)) as Record<string, unknown>;

    if (!(await refill(4))) {
      throw new Error('decodeFrames: truncated body length');
    }
    const bodyLen = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(
      0,
      false
    );
    take(4);

    if (bodyLen > 0) {
      if (!(await refill(bodyLen))) {
        throw new Error('decodeFrames: truncated body bytes');
      }
      // Slice (not subarray) so the yielded body owns its bytes —
      // subsequent reads into the buffer won't overwrite it.
      yield { meta, body: buffer.slice(0, bodyLen) };
      take(bodyLen);
    } else {
      yield { meta, body: new Uint8Array(0) };
    }

    if (meta._end === 1) return;
  }
}

/** Adapt a Web ReadableStream reader to the async-iterator protocol for
 *  runtimes where ReadableStream itself is not async-iterable. */
async function* readerToIterator(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<Uint8Array> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}
