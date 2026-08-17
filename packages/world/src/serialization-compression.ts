import {
  peekSerializationFormat,
  SERIALIZATION_FORMAT_PREFIX_LENGTH,
  SerializationFormat,
} from './serialization-format.js';

interface NodeZlibDecode {
  gunzipSync?: (data: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (data: Uint8Array) => Uint8Array;
}

/** Resolve Node codecs without introducing a static Node import for browsers. */
const nodeZlib = (() => {
  try {
    return (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => NodeZlibDecode };
      }
    ).process?.getBuiltinModule?.('node:zlib');
  } catch {
    return undefined;
  }
})();

function asUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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
  const decompress =
    format === SerializationFormat.ZSTD
      ? nodeZlib?.zstdDecompressSync
      : format === SerializationFormat.GZIP
        ? nodeZlib?.gunzipSync
        : undefined;

  if (!decompress) {
    return format === SerializationFormat.ZSTD ||
      format === SerializationFormat.GZIP
      ? undefined
      : data;
  }

  return asUint8Array(
    decompress(data.subarray(SERIALIZATION_FORMAT_PREFIX_LENGTH))
  );
}
