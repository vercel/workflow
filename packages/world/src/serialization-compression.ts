import {
  peekSerializationFormat,
  SERIALIZATION_FORMAT_PREFIX_LENGTH,
  SerializationFormat,
} from './serialization-format.js';

type NodeCompress = (data: Uint8Array, options?: unknown) => Uint8Array;
type NodeDecompress = (data: Uint8Array) => Uint8Array;

interface NodeZlib {
  constants?: Record<string, number>;
  gzipSync?: NodeCompress;
  gunzipSync?: NodeDecompress;
  zstdCompressSync?: NodeCompress;
  zstdDecompressSync?: NodeDecompress;
}

interface NativeCompressionCodec {
  compress(data: Uint8Array, level?: number): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

/** Resolve Node codecs without introducing a static Node import for browsers. */
const nodeZlib = (() => {
  try {
    return (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => NodeZlib };
      }
    ).process?.getBuiltinModule?.('node:zlib');
  } catch {
    return undefined;
  }
})();

function asUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function nativeCodec(
  compress: NodeCompress | undefined,
  decompress: NodeDecompress | undefined,
  levelParameter?: number
): NativeCompressionCodec | undefined {
  if (!compress || !decompress) return undefined;

  return {
    compress(data, level) {
      const options =
        level !== undefined && levelParameter !== undefined
          ? { params: { [levelParameter]: level } }
          : undefined;
      return asUint8Array(compress(data, options));
    },
    decompress(data) {
      return asUint8Array(decompress(data));
    },
  };
}

const nativeCodecs = {
  gzip: nativeCodec(nodeZlib?.gzipSync, nodeZlib?.gunzipSync),
  zstd: nativeCodec(
    nodeZlib?.zstdCompressSync,
    nodeZlib?.zstdDecompressSync,
    nodeZlib?.constants?.ZSTD_c_compressionLevel
  ),
};

/** Return a native codec only when both its reader and writer are available. */
export function getNativeCompressionCodec(
  codec: 'gzip' | 'zstd'
): NativeCompressionCodec | undefined {
  return nativeCodecs[codec];
}

/**
 * Inflate a persisted gzip/zstd envelope synchronously when Node exposes the
 * corresponding codec. Non-compressed bytes pass through unchanged; an
 * unavailable codec returns `undefined` so the owning runtime can choose its
 * fallback or error contract.
 */
export function decompressSerializedDataSync(
  data: Uint8Array
): Uint8Array | undefined {
  const format = peekSerializationFormat(data);
  const codec =
    format === SerializationFormat.ZSTD
      ? nativeCodecs.zstd
      : format === SerializationFormat.GZIP
        ? nativeCodecs.gzip
        : undefined;

  if (!codec) {
    return format === SerializationFormat.ZSTD ||
      format === SerializationFormat.GZIP
      ? undefined
      : data;
  }

  return codec.decompress(data.subarray(SERIALIZATION_FORMAT_PREFIX_LENGTH));
}
