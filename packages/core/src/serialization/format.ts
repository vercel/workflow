/**
 * Format prefix system for serialized payloads.
 *
 * All serialized payloads are prefixed with a 4-byte format identifier that
 * allows the deserializer to determine how to decode the payload. This enables:
 *
 * 1. Self-describing payloads — the World layer is agnostic to serialization format
 * 2. Gradual migration — old runs keep working, new runs can use new formats
 * 3. Composability — encryption can wrap any format ("encr" wrapping "devl")
 * 4. Debugging — raw data inspection immediately reveals the format
 *
 * Format: [4 bytes: format identifier][payload]
 *
 * The format prefix is open-ended — any 4-character [a-z0-9] string is valid.
 * This allows new codecs to be added without modifying this module.
 */

import {
  type FormatPrefix,
  isFormatPrefix,
  SerializationFormat,
} from './types.js';

/** Length of the format prefix in bytes */
const FORMAT_PREFIX_LENGTH = 4;

const formatEncoder = new TextEncoder();
const formatDecoder = new TextDecoder();

/**
 * Encode a payload with a format prefix.
 *
 * @param format - The format identifier (4 chars, [a-z0-9])
 * @param payload - The serialized payload bytes
 * @returns A new Uint8Array with format prefix prepended
 */
export function encodeWithFormatPrefix(
  format: FormatPrefix,
  payload: Uint8Array
): Uint8Array {
  const prefixBytes = formatEncoder.encode(format);
  const result = new Uint8Array(FORMAT_PREFIX_LENGTH + payload.length);
  result.set(prefixBytes, 0);
  result.set(payload, FORMAT_PREFIX_LENGTH);
  return result;
}

/**
 * Peek at the format prefix without consuming it.
 *
 * Returns the prefix if it's a valid format prefix ([a-z0-9]{4}),
 * or null if the data is legacy/non-binary or doesn't start with a
 * valid prefix.
 *
 * @param data - The format-prefixed data
 * @returns The format prefix, or null
 */
export function peekFormatPrefix(data: Uint8Array): FormatPrefix | null {
  if (data.length < FORMAT_PREFIX_LENGTH) {
    return null;
  }
  const prefixBytes = data.subarray(0, FORMAT_PREFIX_LENGTH);
  const str = formatDecoder.decode(prefixBytes);
  return isFormatPrefix(str) ? str : null;
}

/**
 * Check if data is encrypted, whether symmetrically (`encr`) or sealed to a
 * run's public key (`encp`). Use the exact prefix when the scheme matters.
 */
export function isEncrypted(data: unknown): boolean {
  if (!(data instanceof Uint8Array)) return false;
  const prefix = peekFormatPrefix(data);
  return (
    prefix === SerializationFormat.ENCRYPTED ||
    prefix === SerializationFormat.SEALED
  );
}

/**
 * Decode a format-prefixed payload.
 *
 * Unlike the legacy implementation which only accepted known formats
 * (`devl`, `encr`), this function accepts any valid format prefix
 * (`[a-z0-9]{4}`). This is intentional for forward compatibility —
 * new codecs (e.g. `cbor`) can be added without modifying this module.
 * Callers are responsible for checking whether they support the returned
 * format and throwing an appropriate error if not (e.g. "Unsupported
 * serialization format").
 *
 * @param data - The format-prefixed data
 * @returns An object with the format prefix and payload
 * @throws Error if the data is too short or has an invalid prefix
 */
export function decodeFormatPrefix(data: Uint8Array): {
  format: FormatPrefix;
  payload: Uint8Array;
} {
  if (data.length < FORMAT_PREFIX_LENGTH) {
    throw new Error(
      `Data too short to contain format prefix: expected at least ${FORMAT_PREFIX_LENGTH} bytes, got ${data.length}`
    );
  }

  const prefixBytes = data.subarray(0, FORMAT_PREFIX_LENGTH);
  const str = formatDecoder.decode(prefixBytes);

  if (!isFormatPrefix(str)) {
    throw new Error(
      `Invalid format prefix: "${str}". Must be 4 characters of [a-z0-9].`
    );
  }

  const payload = data.subarray(FORMAT_PREFIX_LENGTH);
  return { format: str, payload };
}
