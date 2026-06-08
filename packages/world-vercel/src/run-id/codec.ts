/**
 * Low-level bit / Crockford-Base32 plumbing for tagged ULIDs.
 *
 * A ULID is a 128-bit value rendered as 26 Crockford-Base32 characters. Since
 * 26 * 5 = 130 bits, the encoded representation has 2 leading zero pad bits
 * — i.e. the top 2 bits of the first character must always be 0. This means
 * the first character of any valid ULID lies in the range `0`..`7`.
 *
 * The tagged-ULID layout (see ./regions.ts and ./index.ts for context):
 *
 *   byte[0]            bit 7       TAG bit (1 = tagged run ID)
 *   byte[6]            bits 2..7   `regionId` (6-bit field, MSB-first)
 *   byte[6]            bits 0..1   high 2 bits of `version` (5-bit field)
 *   byte[7]            bits 5..7   low 3 bits of `version`
 *
 * Encode sets the tag bit on byte[0] and overwrites the 11 metadata bits at
 * the **top** of the randomness section (bytes[6..7]). Decode reads + clears
 * only the tag bit, leaving the metadata bits intact in the returned
 * "untagged" ULID. Placing the metadata at the top of randomness (rather
 * than the bottom) leaves the low 69 bits free, so a `monotonicFactory()`-
 * style ULID generator's bottom-bit increments survive encoding and
 * intra-millisecond lexicographic order is preserved (provided callers
 * don't change `(regionId, version)` mid-millisecond).
 */

// Crockford Base32 alphabet (matches the `ulid` spec).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Decode table: ASCII char code -> 5-bit value, or -1 if invalid.
const DECODE_TABLE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ENCODING.length; i++) {
    table[ENCODING.charCodeAt(i)] = i;
  }
  // Crockford-Base32 case-insensitivity: also accept lowercase.
  for (let i = 0; i < ENCODING.length; i++) {
    const lower = ENCODING[i].toLowerCase();
    if (lower !== ENCODING[i]) {
      table[lower.charCodeAt(0)] = i;
    }
  }
  return table;
})();

export const ULID_LENGTH = 26;
export const ULID_BYTE_LENGTH = 16;

/** Bit masks used by the tagged-ULID layout. */
export const TAG_BIT_MASK = 0x80; // byte[0] bit 7
/** `regionId` occupies the top 6 bits of byte[6]. */
export const REGION_MASK = 0xfc;
/** High 2 bits of `version` occupy the bottom 2 bits of byte[6]. */
export const VERSION_HIGH_MASK = 0x03;
/** Low 3 bits of `version` occupy the top 3 bits of byte[7]. */
export const VERSION_LOW_MASK = 0xe0;
/** Byte indices of the metadata region within the 16-byte ULID buffer. */
export const REGION_BYTE_INDEX = 6;
export const VERSION_LOW_BYTE_INDEX = 7;
export const VERSION_BIT_WIDTH = 5;
export const REGION_BIT_WIDTH = 6;
export const MAX_VERSION = (1 << VERSION_BIT_WIDTH) - 1; // 31
export const MAX_REGION = (1 << REGION_BIT_WIDTH) - 1; // 63

/**
 * Decode a 26-character Crockford-Base32 ULID string into 16 bytes.
 *
 * Throws if the string is not exactly 26 characters, contains an invalid
 * Crockford character, or has nonzero top 2 pad bits (which would imply the
 * value overflows 128 bits).
 */
export function ulidToBytes(ulid: string): Uint8Array {
  if (typeof ulid !== 'string') {
    throw new TypeError(`Expected ULID string, got ${typeof ulid}`);
  }
  if (ulid.length !== ULID_LENGTH) {
    throw new Error(
      `Invalid ULID length: expected ${ULID_LENGTH}, got ${ulid.length}`
    );
  }

  // Validate and convert each char to its 5-bit value.
  const values = new Uint8Array(ULID_LENGTH);
  for (let i = 0; i < ULID_LENGTH; i++) {
    const code = ulid.charCodeAt(i);
    const v = code < 128 ? DECODE_TABLE[code] : -1;
    if (v < 0) {
      throw new Error(
        `Invalid Crockford-Base32 character at index ${i}: ${JSON.stringify(ulid[i])}`
      );
    }
    values[i] = v;
  }

  // The first character carries only 3 real bits (the top 2 must be zero pad).
  if ((values[0] & 0x18) !== 0) {
    throw new Error(
      `Invalid ULID: top 2 bits must be zero (first char > '7'): ${JSON.stringify(ulid[0])}`
    );
  }

  // Pack 26 * 5 = 130 bits, with the top 2 bits being zero, into 16 bytes.
  // Stream the values MSB-first into a bit buffer.
  const out = new Uint8Array(ULID_BYTE_LENGTH);
  // Skip the 2 leading zero pad bits by starting the bit cursor at 2.
  let bitBuf = values[0] & 0x07;
  let bitCount = 3;
  let outIdx = 0;
  for (let i = 1; i < ULID_LENGTH; i++) {
    bitBuf = (bitBuf << 5) | values[i];
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      out[outIdx++] = (bitBuf >> bitCount) & 0xff;
    }
  }
  // After consuming all 26 chars (130 bits) starting from a 3-bit prefix,
  // bitCount should be exactly 0 and outIdx should be 16.
  /* c8 ignore next 3 */
  if (outIdx !== ULID_BYTE_LENGTH || bitCount !== 0) {
    throw new Error('Internal error: ULID bit packing did not consume cleanly');
  }
  return out;
}

/**
 * Encode 16 bytes as a 26-character Crockford-Base32 ULID string. The output
 * is always uppercase.
 *
 * Throws if `bytes.length !== 16`.
 */
export function bytesToUlid(bytes: Uint8Array): string {
  if (bytes.length !== ULID_BYTE_LENGTH) {
    throw new Error(
      `Invalid byte length: expected ${ULID_BYTE_LENGTH}, got ${bytes.length}`
    );
  }

  // Emit 26 chars from 128 bits, MSB-first, with 2 leading zero pad bits
  // implicitly contributed by starting the bit buffer empty (bitCount = 0)
  // and producing the first 5-bit chunk only after we've shifted in 3 real
  // bits — i.e. we encode by appending bytes and pulling 5-bit groups off
  // the top.
  let bitBuf = 0;
  let bitCount = 0;
  // Pre-load 3 zero bits (i.e., start with bitCount = -2 conceptually). The
  // simpler way: shift in 3 zero bits up front, so the first 5-bit chunk
  // pulled out consists of those 3 zeros + the top 2 bits of byte[0].
  // Equivalently, treat the value as a 130-bit number with the top 2 bits = 0.
  bitBuf = 0;
  bitCount = 2; // 2 zero pad bits already "in" the buffer at the top
  let out = '';
  for (let i = 0; i < ULID_BYTE_LENGTH; i++) {
    bitBuf = (bitBuf << 8) | bytes[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ENCODING[(bitBuf >> bitCount) & 0x1f];
    }
  }
  /* c8 ignore next 3 */
  if (out.length !== ULID_LENGTH || bitCount !== 0) {
    throw new Error('Internal error: ULID bit packing did not flush cleanly');
  }
  return out;
}

/**
 * Test whether `s` is a fully valid 26-character Crockford-Base32 ULID with
 * the tag bit set. Returns `false` for any input that is not a string, has
 * the wrong length, contains an invalid character, or has nonzero top 2
 * padding bits.
 */
export function isTaggedString(s: unknown): boolean {
  if (typeof s !== 'string' || s.length !== ULID_LENGTH) return false;
  let bytes: Uint8Array;
  try {
    bytes = ulidToBytes(s);
  } catch {
    return false;
  }
  return (bytes[0] & TAG_BIT_MASK) !== 0;
}
