declare const formatPrefixBrand: unique symbol;

/** A validated four-byte lowercase alphanumeric payload envelope prefix. */
export type FormatPrefix = string & {
  readonly [formatPrefixBrand]: 'FormatPrefix';
};

/** Whether a value is a valid persisted payload envelope prefix. */
export function isFormatPrefix(value: unknown): value is FormatPrefix {
  return (
    typeof value === 'string' &&
    value.length === 4 &&
    /^[a-z0-9]{4}$/.test(value)
  );
}

function defineFormatPrefix<const T extends string>(
  value: T
): T & FormatPrefix {
  if (!isFormatPrefix(value)) {
    throw new Error(`Invalid serialization format prefix: ${value}`);
  }
  return value;
}

/** Known four-byte envelope prefixes in the persisted payload protocol. */
export const SerializationFormat = {
  /** devalue stringify/parse with TextEncoder/TextDecoder */
  DEVALUE_V1: defineFormatPrefix('devl'),
  /** Symmetrically encrypted payload */
  ENCRYPTED: defineFormatPrefix('encr'),
  /** Payload sealed to a run's public key */
  SEALED: defineFormatPrefix('encp'),
  /** Gzip-compressed payload */
  GZIP: defineFormatPrefix('gzip'),
  /** Zstandard-compressed payload */
  ZSTD: defineFormatPrefix('zstd'),
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

export const SERIALIZATION_FORMAT_PREFIX_LENGTH = 4;
const formatDecoder = new TextDecoder();

/** Read a known persisted payload format without consuming its bytes. */
export function peekSerializationFormat(
  value: unknown
): SerializationFormatType | null {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < SERIALIZATION_FORMAT_PREFIX_LENGTH
  ) {
    return null;
  }

  const format = formatDecoder.decode(
    value.subarray(0, SERIALIZATION_FORMAT_PREFIX_LENGTH)
  );
  return isSerializationFormat(format) ? format : null;
}
