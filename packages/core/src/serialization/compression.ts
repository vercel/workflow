/**
 * Composable compression layer for serialized data.
 *
 * Wraps/unwraps serialized payloads with gzip compression, using the
 * format prefix system to mark compressed data ('gzip' wrapping the
 * inner format, e.g. 'gzip' + deflate('devl' + payload)).
 *
 * Layering order with encryption: compression is applied BEFORE
 * encryption (encr(gzip(devl))) — encrypted bytes are high-entropy and
 * do not compress, so the reverse order would be a no-op.
 *
 * Compression is conditional:
 * - Payloads smaller than {@link COMPRESSION_MIN_BYTES} are passed
 *   through unchanged (gzip overhead isn't worth it).
 * - If the compressed result isn't meaningfully smaller than the
 *   original (see {@link COMPRESSION_MIN_SAVINGS_RATIO}), the original
 *   is kept. This protects already-compressed binary payloads (images,
 *   archives, etc.) from wasted CPU and size inflation.
 *
 * Decompression is unconditional: any payload carrying the 'gzip'
 * prefix is inflated, so readers transparently handle both compressed
 * and uncompressed data regardless of write-side settings.
 */

import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  peekFormatPrefix,
} from './format.js';
import { SerializationFormat } from './types.js';

/**
 * Payloads below this size are never compressed. The 4-byte format
 * prefix + ~20 bytes of gzip header/trailer overhead means small
 * payloads gain nothing, and tiny ones would grow.
 */
export const COMPRESSION_MIN_BYTES = 1024;

/**
 * Compression must shave off at least this fraction of the payload
 * size to be kept; otherwise the uncompressed original is stored.
 * Guards against incompressible (already-compressed / high-entropy)
 * data paying a permanent decompression tax for a negligible win.
 */
export const COMPRESSION_MIN_SAVINGS_RATIO = 0.05;

/**
 * Escape hatch: set WORKFLOW_DISABLE_COMPRESSION=1 to disable
 * write-side compression entirely. Reads are unaffected — payloads
 * that were already written compressed remain readable.
 */
function isCompressionDisabledByEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      process.env?.WORKFLOW_DISABLE_COMPRESSION === '1'
    );
  } catch {
    return false;
  }
}

/**
 * Pipe bytes through a (De)CompressionStream and collect the output.
 */
async function pipeThroughTransform(
  data: Uint8Array,
  transform: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Don't await the write before reading — the transform's internal
  // queue can fill up on large payloads, deadlocking writer vs reader.
  const writePromise = writer.write(data).then(() => writer.close());
  // If the transform errors, the reader.read() below rejects first and
  // propagates; mark the write side as handled so the mirrored rejection
  // doesn't surface as an unhandled rejection.
  writePromise.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await writePromise;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThroughTransform(data, new CompressionStream('gzip'));
}

async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThroughTransform(data, new DecompressionStream('gzip'));
}

/**
 * Whether the current runtime can compress/decompress. CompressionStream
 * is a web standard available in Node.js 18+, browsers, and edge
 * runtimes; this guard exists for exotic runtimes only.
 */
function isCompressionAvailable(): boolean {
  return (
    typeof CompressionStream === 'function' &&
    typeof DecompressionStream === 'function'
  );
}

/**
 * Compress a format-prefixed payload if compression is enabled for the
 * target run and the payload is worth compressing.
 *
 * @param data - The format-prefixed serialized data (e.g. 'devl' + bytes)
 * @param enabled - Whether the target run supports compressed payloads
 *   (run specVersion >= SPEC_VERSION_SUPPORTS_COMPRESSION, and for
 *   cross-deployment writes, the target deployment's capabilities —
 *   see `getRunCapabilities` in capabilities.ts)
 * @returns The compressed data with 'gzip' prefix, or the original data
 *   when compression is disabled, unavailable, or not worthwhile
 */
export async function compress(
  data: Uint8Array | unknown,
  enabled: boolean
): Promise<Uint8Array | unknown> {
  if (!enabled || !(data instanceof Uint8Array)) return data;
  if (data.length < COMPRESSION_MIN_BYTES) return data;
  if (isCompressionDisabledByEnv() || !isCompressionAvailable()) return data;

  const compressed = await gzipBytes(data);
  const wrappedLength = 4 + compressed.length; // format prefix + payload
  if (wrappedLength >= data.length * (1 - COMPRESSION_MIN_SAVINGS_RATIO)) {
    return data;
  }
  return encodeWithFormatPrefix(SerializationFormat.GZIP, compressed);
}

/**
 * Decompress a format-prefixed payload if it's compressed.
 * Strips the 'gzip' format prefix and inflates the inner payload
 * (which carries its own format prefix, e.g. 'devl').
 *
 * Non-compressed data (including non-binary legacy data) is returned
 * unchanged, so this is safe to apply unconditionally on read paths.
 */
export async function decompress(
  data: Uint8Array | unknown
): Promise<Uint8Array | unknown> {
  if (!(data instanceof Uint8Array)) return data;
  if (peekFormatPrefix(data) !== SerializationFormat.GZIP) return data;

  if (!isCompressionAvailable()) {
    throw new Error(
      'Compressed (gzip) workflow data encountered but DecompressionStream ' +
        'is not available in this runtime. Node.js 18+, browsers, and edge ' +
        'runtimes all support it.'
    );
  }

  const { payload } = decodeFormatPrefix(data);
  return gunzipBytes(payload);
}

/**
 * Check if data is compressed (has 'gzip' format prefix).
 */
export function isCompressed(data: Uint8Array | unknown): boolean {
  return peekFormatPrefix(data) === SerializationFormat.GZIP;
}
