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
 * Telemetry sink describing what the compression layer did to a payload.
 * Populated by {@link compress} (write) and {@link decompress} (read) when
 * a `stats` object is passed. Sizes are measured at the compression
 * boundary — i.e. before encryption is layered on the write side and after
 * decryption on the read side — so they reflect compression's effect, not
 * the at-rest size (which also includes the `encr` envelope and, on some
 * backends, base64 expansion).
 *
 * Field meanings are identical for both directions:
 * - `uncompressedBytes`: the logical (devalue-prefixed) payload size.
 * - `storedBytes`: the size handed to / read from storage (compressed when
 *   the gzip codec applied, otherwise equal to `uncompressedBytes`).
 */
export interface CompressionStats {
  /** True once the compression layer ran (i.e. saw binary data). */
  recorded?: boolean;
  /** Whether the gzip codec was applied (write) or present (read). */
  compressed?: boolean;
  /** Logical, uncompressed payload size in bytes. */
  uncompressedBytes?: number;
  /** Stored (post-compression) payload size in bytes. */
  storedBytes?: number;
}

function recordStats(
  stats: CompressionStats | undefined,
  compressed: boolean,
  uncompressedBytes: number,
  storedBytes: number
): void {
  if (!stats) return;
  stats.recorded = true;
  stats.compressed = compressed;
  stats.uncompressedBytes = uncompressedBytes;
  stats.storedBytes = storedBytes;
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
 * @param stats - Optional telemetry sink; populated when `data` is binary.
 * @returns The compressed data with 'gzip' prefix, or the original data
 *   when compression is disabled, unavailable, or not worthwhile
 */
export async function compress(
  data: Uint8Array | unknown,
  enabled: boolean,
  stats?: CompressionStats
): Promise<Uint8Array | unknown> {
  if (!(data instanceof Uint8Array)) return data;
  // From here `data` is binary, so every return path records stats.
  if (
    !enabled ||
    data.length < COMPRESSION_MIN_BYTES ||
    isCompressionDisabledByEnv() ||
    !isCompressionAvailable()
  ) {
    recordStats(stats, false, data.length, data.length);
    return data;
  }

  const compressed = await gzipBytes(data);
  const wrappedLength = 4 + compressed.length; // format prefix + payload
  if (wrappedLength >= data.length * (1 - COMPRESSION_MIN_SAVINGS_RATIO)) {
    recordStats(stats, false, data.length, data.length);
    return data;
  }
  recordStats(stats, true, data.length, wrappedLength);
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
  data: Uint8Array | unknown,
  stats?: CompressionStats
): Promise<Uint8Array | unknown> {
  if (!(data instanceof Uint8Array)) return data;
  if (peekFormatPrefix(data) !== SerializationFormat.GZIP) {
    recordStats(stats, false, data.length, data.length);
    return data;
  }

  if (!isCompressionAvailable()) {
    throw new Error(
      'Compressed (gzip) workflow data encountered but DecompressionStream ' +
        'is not available in this runtime. Node.js 18+, browsers, and edge ' +
        'runtimes all support it.'
    );
  }

  const { payload } = decodeFormatPrefix(data);
  const inflated = await gunzipBytes(payload);
  recordStats(stats, true, inflated.length, data.length);
  return inflated;
}

/**
 * Check if data is compressed (has 'gzip' format prefix).
 */
export function isCompressed(data: Uint8Array | unknown): boolean {
  return peekFormatPrefix(data) === SerializationFormat.GZIP;
}
