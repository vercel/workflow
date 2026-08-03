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
 * `CompressionStream`. `WORKFLOW_COMPRESSION_CODEC=gzip` forces the
 * portable codec.
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
 * Optional codec override (`WORKFLOW_COMPRESSION_CODEC=gzip|zstd`). Lets an
 * operator pin the portable codec (gzip) — useful for A/B comparisons or
 * runtimes where zstd read support isn't yet everywhere.
 */
function codecOverrideFromEnv(): 'gzip' | 'zstd' | undefined {
  try {
    const v = process.env?.WORKFLOW_COMPRESSION_CODEC;
    return v === 'gzip' || v === 'zstd' ? v : undefined;
  } catch {
    return undefined;
  }
}

interface NodeZlib {
  zstdCompressSync?: (data: Uint8Array, opts?: unknown) => Uint8Array;
  zstdDecompressSync?: (data: Uint8Array) => Uint8Array;
  constants?: Record<string, number>;
}

/**
 * Resolve `node:zlib` via `process.getBuiltinModule` — no static import, so
 * this module stays bundler-safe for browser/edge targets (where it returns
 * undefined and we fall back to gzip).
 */
function getNodeZlib(): NodeZlib | undefined {
  try {
    return (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => NodeZlib };
      }
    ).process?.getBuiltinModule?.('node:zlib');
  } catch {
    return undefined;
  }
}

function isZstdAvailable(): boolean {
  const z = getNodeZlib();
  return (
    typeof z?.zstdCompressSync === 'function' &&
    typeof z?.zstdDecompressSync === 'function'
  );
}

/**
 * gzip via the web-standard `CompressionStream` (Node 18+, browsers, edge).
 */
function isGzipAvailable(): boolean {
  return (
    typeof CompressionStream === 'function' &&
    typeof DecompressionStream === 'function'
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

function zstdBytes(data: Uint8Array): Uint8Array {
  const z = getNodeZlib();
  const level = z?.constants?.ZSTD_c_compressionLevel;
  const opts =
    level !== undefined ? { params: { [level]: ZSTD_LEVEL } } : undefined;
  // biome-ignore lint/style/noNonNullAssertion: guarded by isZstdAvailable()
  return new Uint8Array(z!.zstdCompressSync!(data, opts));
}

function unzstdBytes(data: Uint8Array): Uint8Array {
  const z = getNodeZlib();
  if (!z?.zstdDecompressSync) {
    throw new Error(
      'Compressed (zstd) workflow data encountered but node:zlib zstd ' +
        'support is not available in this runtime (requires Node.js 22.15+). ' +
        'In the browser, register a zstd decoder via registerZstdDecoder ' +
        '(serialization-format.ts).'
    );
  }
  return new Uint8Array(z.zstdDecompressSync(data));
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
  if (override === 'gzip') return isGzipAvailable() ? 'gzip' : 'none';
  // Default and explicit 'zstd' both prefer zstd, then fall back to gzip.
  if (isZstdAvailable()) return 'zstd';
  if (isGzipAvailable()) return 'gzip';
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

  const compressed = codec === 'zstd' ? zstdBytes(data) : await gzipBytes(data);
  const format =
    codec === 'zstd' ? SerializationFormat.ZSTD : SerializationFormat.GZIP;
  const wrappedLength = 4 + compressed.length; // format prefix + payload
  if (wrappedLength >= data.length * (1 - COMPRESSION_MIN_SAVINGS_RATIO)) {
    recordStats(stats, 'none', data.length, data.length);
    return data;
  }
  recordStats(stats, codec, data.length, wrappedLength);
  return encodeWithFormatPrefix(format, compressed);
}

/**
 * Decompress a format-prefixed payload if it's compressed.
 * Dispatches on the prefix ('zstd' or 'gzip') and inflates the inner
 * payload (which carries its own format prefix, e.g. 'devl').
 *
 * Non-compressed data (including non-binary legacy data) is returned
 * unchanged, so this is safe to apply unconditionally on read paths.
 */
export async function decompress(
  data: Uint8Array | unknown,
  stats?: CompressionStats
): Promise<Uint8Array | unknown> {
  if (!(data instanceof Uint8Array)) return data;
  const prefix = peekFormatPrefix(data);

  if (prefix === SerializationFormat.ZSTD) {
    const { payload } = decodeFormatPrefix(data);
    const inflated = unzstdBytes(payload);
    recordStats(stats, 'zstd', inflated.length, data.length);
    return inflated;
  }

  if (prefix === SerializationFormat.GZIP) {
    if (!isGzipAvailable()) {
      throw new Error(
        'Compressed (gzip) workflow data encountered but DecompressionStream ' +
          'is not available in this runtime. Node.js 18+, browsers, and edge ' +
          'runtimes all support it.'
      );
    }
    const { payload } = decodeFormatPrefix(data);
    const inflated = await gunzipBytes(payload);
    recordStats(stats, 'gzip', inflated.length, data.length);
    return inflated;
  }

  recordStats(stats, 'none', data.length, data.length);
  return data;
}

/**
 * Check if data is compressed (has a 'zstd' or 'gzip' format prefix).
 */
export function isCompressed(data: Uint8Array | unknown): boolean {
  const prefix = peekFormatPrefix(data);
  return (
    prefix === SerializationFormat.ZSTD || prefix === SerializationFormat.GZIP
  );
}
