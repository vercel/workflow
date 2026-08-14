/**
 * Composable compression layer for serialized data.
 *
 * Wraps/unwraps serialized payloads with a compression codec, using the
 * format prefix system to mark compressed data (e.g. 'zstd' or 'gzip'
 * wrapping the inner format: 'zstd' + zstd('devl' + payload)).
 *
 * Codec selection (write side): zstd is preferred — it is markedly faster
 * than gzip at a comparable-or-better ratio (see scripts/README.md), and
 * compression runs at every step boundary so the write CPU is a per-step
 * tax. zstd requires `node:zlib` >= 22.15 (Web `CompressionStream` has no
 * zstd), so on a runtime without it we fall back to gzip via the portable
 * `CompressionStream`. `WORKFLOW_COMPRESSION_CODEC=gzip` forces gzip.
 *
 * Read side: dispatch on the format prefix, so both 'zstd' and 'gzip'
 * payloads are always decodable regardless of which codec wrote them.
 * (The browser o11y read path decodes zstd via a registered WASM decoder —
 * see `serialization-format.ts`; this module's `decompress` is the Node
 * runtime/replay path and uses `node:zlib`.)
 *
 * Layering order with encryption: compression is applied BEFORE
 * encryption (encr(zstd(devl))) — encrypted bytes are high-entropy and
 * do not compress, so the reverse order would be a no-op.
 *
 * Compression is conditional:
 * - Payloads smaller than {@link COMPRESSION_MIN_BYTES} are passed
 *   through unchanged (codec overhead isn't worth it).
 * - If the compressed result isn't meaningfully smaller than the
 *   original (see {@link COMPRESSION_MIN_SAVINGS_RATIO}), the original
 *   is kept. This protects already-compressed binary payloads (images,
 *   archives, etc.) from wasted CPU and size inflation.
 */

import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  peekFormatPrefix,
} from './format.js';
import { SerializationFormat } from './types.js';

/**
 * Payloads below this size are never compressed. The 4-byte format
 * prefix + codec header/trailer overhead means small payloads gain
 * nothing, and tiny ones would grow.
 */
export const COMPRESSION_MIN_BYTES = 1024;

/**
 * Compression must shave off at least this fraction of the payload
 * size to be kept; otherwise the uncompressed original is stored.
 * Guards against incompressible (already-compressed / high-entropy)
 * data paying a permanent decompression tax for a negligible win.
 */
export const COMPRESSION_MIN_SAVINGS_RATIO = 0.05;

/** Default zstd compression level — the sweet spot of speed vs ratio. */
const ZSTD_LEVEL = 3;

/** Which codec compressed a payload (or `none` when stored uncompressed). */
export type CompressionCodec = 'zstd' | 'gzip' | 'none';

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
 * Optional codec override (`WORKFLOW_COMPRESSION_CODEC=gzip|zstd`). Useful
 * for A/B comparisons or runtimes where zstd read support isn't everywhere.
 */
function codecOverrideFromEnv(): 'gzip' | 'zstd' | undefined {
  try {
    const v = process.env?.WORKFLOW_COMPRESSION_CODEC;
    return v === 'gzip' || v === 'zstd' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `node:zlib` via `process.getBuiltinModule` — no static import, so
 * this module stays bundler-safe for browser/edge targets (where it returns
 * undefined and we fall back to gzip).
 */
const nodeZlib = (() => {
  try {
    return typeof process === 'undefined'
      ? undefined
      : process.getBuiltinModule('node:zlib');
  } catch {
    return undefined;
  }
})();

let zstdBrowserDecoder:
  | ((payload: Uint8Array) => Promise<Uint8Array>)
  | undefined;

/** Register the zstd decoder used by browser observability clients. */
export function registerZstdDecoder(
  decoder: (payload: Uint8Array) => Promise<Uint8Array>
): void {
  zstdBrowserDecoder = decoder;
}

function isZstdAvailable(): boolean {
  return (
    typeof nodeZlib?.zstdCompressSync === 'function' &&
    typeof nodeZlib?.zstdDecompressSync === 'function'
  );
}

/**
 * gzip via the web-standard `CompressionStream` (Node 18+, browsers, edge).
 */
function canCompressGzip(): boolean {
  return (
    typeof nodeZlib?.gzipSync === 'function' ||
    typeof CompressionStream === 'function'
  );
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
  for await (const chunk of transform.readable) {
    chunks.push(chunk);
    total += chunk.length;
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

function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThroughTransform(data, new CompressionStream('gzip'));
}

function gzip(data: Uint8Array): Uint8Array | Promise<Uint8Array> {
  return nodeZlib?.gzipSync
    ? new Uint8Array(nodeZlib.gzipSync(data))
    : gzipBytes(data);
}

function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThroughTransform(data, new DecompressionStream('gzip'));
}

function zstdBytes(data: Uint8Array): Uint8Array {
  const compress = nodeZlib?.zstdCompressSync;
  if (!compress) {
    throw new Error('zstd compression is not available in this runtime');
  }
  const level = nodeZlib?.constants?.ZSTD_c_compressionLevel;
  const opts =
    level !== undefined ? { params: { [level]: ZSTD_LEVEL } } : undefined;
  return new Uint8Array(compress(data, opts));
}

function decompressZstd(payload: Uint8Array): Uint8Array | Promise<Uint8Array> {
  if (nodeZlib?.zstdDecompressSync) {
    return new Uint8Array(nodeZlib.zstdDecompressSync(payload));
  }
  if (zstdBrowserDecoder) return zstdBrowserDecoder(payload);
  throw new Error(
    'Compressed (zstd) workflow data encountered but no zstd decoder is ' +
      'available. Node.js 22.15+ decodes natively; in the browser ' +
      'register one via registerZstdDecoder.'
  );
}

function decompressGzip(payload: Uint8Array): Uint8Array | Promise<Uint8Array> {
  if (nodeZlib?.gunzipSync) {
    return new Uint8Array(nodeZlib.gunzipSync(payload));
  }
  if (typeof DecompressionStream === 'function') return gunzipBytes(payload);
  throw new Error(
    'Compressed (gzip) workflow data encountered but no gzip decoder is available.'
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
 *   a codec applied, otherwise equal to `uncompressedBytes`).
 * - `codec`: which codec applied (`none` when stored uncompressed).
 */
export interface CompressionStats {
  /** True once the compression layer ran (i.e. saw binary data). */
  recorded?: boolean;
  /** Whether a codec was applied (write) or present (read). */
  compressed?: boolean;
  /** Which codec applied / was present. */
  codec?: CompressionCodec;
  /** Logical, uncompressed payload size in bytes. */
  uncompressedBytes?: number;
  /** Stored (post-compression) payload size in bytes. */
  storedBytes?: number;
}

function recordStats(
  stats: CompressionStats | undefined,
  codec: CompressionCodec,
  uncompressedBytes: number,
  storedBytes: number
): void {
  if (!stats) return;
  stats.recorded = true;
  stats.compressed = codec !== 'none';
  stats.codec = codec;
  stats.uncompressedBytes = uncompressedBytes;
  stats.storedBytes = storedBytes;
}

/**
 * Choose the write-side codec given runtime availability and the optional
 * env override. zstd is preferred; gzip is the portable fallback.
 */
function selectWriteCodec(): 'zstd' | 'gzip' | 'none' {
  const override = codecOverrideFromEnv();
  if (override === 'gzip') return canCompressGzip() ? 'gzip' : 'none';
  // Default and explicit 'zstd' both prefer zstd, then fall back to gzip.
  if (isZstdAvailable()) return 'zstd';
  if (canCompressGzip()) return 'gzip';
  return 'none';
}

/**
 * Compress a format-prefixed payload if compression is enabled for the
 * target run and the payload is worth compressing.
 *
 * @param data - The format-prefixed serialized data (e.g. 'devl' + bytes)
 * @param enabled - Whether the target run supports compressed payloads
 *   (run specVersion >= SPEC_VERSION_SUPPORTS_COMPRESSION, and for
 *   cross-deployment writes, the target deployment's capabilities —
 *   see `getRunCapabilities` in capabilities.ts). zstd and gzip read
 *   support co-ship, so a single boolean is sufficient.
 * @param stats - Optional telemetry sink; populated when `data` is binary.
 * @returns The compressed data with a codec prefix, or the original data
 *   when compression is disabled, unavailable, or not worthwhile.
 */
export function compress(
  data: Uint8Array,
  enabled: boolean,
  stats?: CompressionStats
): Uint8Array | Promise<Uint8Array> {
  if (
    !enabled ||
    data.length < COMPRESSION_MIN_BYTES ||
    isCompressionDisabledByEnv()
  ) {
    recordStats(stats, 'none', data.length, data.length);
    return data;
  }

  const codec = selectWriteCodec();
  if (codec === 'none') {
    recordStats(stats, 'none', data.length, data.length);
    return data;
  }

  const finish = (compressed: Uint8Array): Uint8Array => {
    const wrappedLength = 4 + compressed.length;
    if (wrappedLength >= data.length * (1 - COMPRESSION_MIN_SAVINGS_RATIO)) {
      recordStats(stats, 'none', data.length, data.length);
      return data;
    }
    recordStats(stats, codec, data.length, wrappedLength);
    return encodeWithFormatPrefix(
      codec === 'zstd' ? SerializationFormat.ZSTD : SerializationFormat.GZIP,
      compressed
    );
  };

  const compressed = codec === 'zstd' ? zstdBytes(data) : gzip(data);
  return compressed instanceof Promise
    ? compressed.then(finish)
    : finish(compressed);
}

/**
 * Decompress a format-prefixed payload if it's compressed.
 * Dispatches on the prefix ('zstd' or 'gzip') and inflates the inner
 * payload (which carries its own format prefix, e.g. 'devl').
 *
 * Non-compressed data is returned unchanged.
 */
export function decompress(
  data: Uint8Array,
  stats?: CompressionStats
): Uint8Array | Promise<Uint8Array> {
  const prefix = peekFormatPrefix(data);

  const codec =
    prefix === SerializationFormat.ZSTD
      ? 'zstd'
      : prefix === SerializationFormat.GZIP
        ? 'gzip'
        : undefined;
  if (!codec) {
    recordStats(stats, 'none', data.length, data.length);
    return data;
  }

  const { payload } = decodeFormatPrefix(data);
  const inflated =
    codec === 'zstd' ? decompressZstd(payload) : decompressGzip(payload);
  const finish = (value: Uint8Array): Uint8Array => {
    recordStats(stats, codec, value.length, data.length);
    return value;
  };
  return inflated instanceof Promise ? inflated.then(finish) : finish(inflated);
}

/**
 * Decompress without starting a portable asynchronous codec. Observability's
 * synchronous hydration path uses this to leave browser data untouched until
 * its async hydration path is requested.
 */
export function decompressSync(data: Uint8Array): Uint8Array | undefined {
  const prefix = peekFormatPrefix(data);
  if (prefix === SerializationFormat.ZSTD) {
    const decompress = nodeZlib?.zstdDecompressSync;
    return decompress
      ? new Uint8Array(decompress(decodeFormatPrefix(data).payload))
      : undefined;
  }
  if (prefix === SerializationFormat.GZIP) {
    const decompress = nodeZlib?.gunzipSync;
    return decompress
      ? new Uint8Array(decompress(decodeFormatPrefix(data).payload))
      : undefined;
  }
  return data;
}

/**
 * Check if data is compressed (has a 'zstd' or 'gzip' format prefix).
 */
export function isCompressed(data: Uint8Array): boolean {
  const prefix = peekFormatPrefix(data);
  return (
    prefix === SerializationFormat.ZSTD || prefix === SerializationFormat.GZIP
  );
}
