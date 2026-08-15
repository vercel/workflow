/** Known four-byte envelope prefixes in the persisted payload protocol. */
export const SerializationFormat = {
  /** devalue stringify/parse with TextEncoder/TextDecoder */
  DEVALUE_V1: 'devl',
  /** Symmetrically encrypted payload */
  ENCRYPTED: 'encr',
  /** Payload sealed to a run's public key */
  SEALED: 'encp',
  /** Gzip-compressed payload */
  GZIP: 'gzip',
  /** Zstandard-compressed payload */
  ZSTD: 'zstd',
} as const;

export type SerializationFormatType =
  (typeof SerializationFormat)[keyof typeof SerializationFormat];

const serializationFormats = new Set<string>(
  Object.values(SerializationFormat)
);

/** Whether a value is one of the persisted payload protocol's known formats. */
export function isSerializationFormat(
  value: unknown
): value is SerializationFormatType {
  return typeof value === 'string' && serializationFormats.has(value);
}

const FORMAT_PREFIX_LENGTH = 4;
const formatDecoder = new TextDecoder();

/** Read a known persisted payload format without consuming its bytes. */
export function peekSerializationFormat(
  value: unknown
): SerializationFormatType | null {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < FORMAT_PREFIX_LENGTH
  ) {
    return null;
  }

  const format = formatDecoder.decode(value.subarray(0, FORMAT_PREFIX_LENGTH));
  return isSerializationFormat(format) ? format : null;
}
