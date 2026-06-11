import { describe, expect, it } from 'vitest';
import {
  bytesToUlid,
  isTaggedString,
  TAG_BIT_MASK,
  ULID_BYTE_LENGTH,
  ULID_LENGTH,
  ulidToBytes,
} from './codec.js';

/**
 * Reference ULID with all bytes = 0. Crockford encoding of 16 zero bytes is
 * 26 '0' chars.
 */
const ZERO_ULID = '0'.repeat(ULID_LENGTH);

/**
 * Reference ULID with all bytes = 0xff. Crockford encoding of 16 0xff bytes
 * is the 26-char value "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" (the top char carries
 * only 3 real bits, so its max is 7).
 */
const MAX_ULID = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';

describe('codec / ulidToBytes & bytesToUlid', () => {
  it('round-trips the all-zero ULID', () => {
    const bytes = ulidToBytes(ZERO_ULID);
    expect(bytes).toEqual(new Uint8Array(ULID_BYTE_LENGTH));
    expect(bytesToUlid(bytes)).toBe(ZERO_ULID);
  });

  it('round-trips the all-ones ULID', () => {
    const bytes = ulidToBytes(MAX_ULID);
    expect(bytes).toEqual(new Uint8Array(ULID_BYTE_LENGTH).fill(0xff));
    expect(bytesToUlid(bytes)).toBe(MAX_ULID);
  });

  it('round-trips a typical ULID-shaped value', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const bytes = ulidToBytes(ulid);
    expect(bytes).toHaveLength(ULID_BYTE_LENGTH);
    // Sanity-check the byte-level decoding of this ULID-spec example string.
    expect(Array.from(bytes)).toEqual([
      0x01, 0x56, 0x3e, 0x3a, 0xb5, 0xd3, 0xd6, 0x76, 0x4c, 0x61, 0xef, 0xb9,
      0x93, 0x02, 0xbd, 0x5b,
    ]);
    expect(bytesToUlid(bytes)).toBe(ulid);
  });

  it('decodes lowercase Crockford characters and emits uppercase', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(bytesToUlid(ulidToBytes(ulid.toLowerCase()))).toBe(ulid);
  });

  it('rejects strings of the wrong length', () => {
    expect(() => ulidToBytes('')).toThrow(/Invalid ULID length/);
    expect(() => ulidToBytes('0'.repeat(25))).toThrow(/Invalid ULID length/);
    expect(() => ulidToBytes('0'.repeat(27))).toThrow(/Invalid ULID length/);
  });

  it('rejects strings with invalid Crockford characters', () => {
    // 'U' is invalid in Crockford Base32.
    const bad = `U${ZERO_ULID.slice(1)}`;
    expect(() => ulidToBytes(bad)).toThrow(
      /Invalid Crockford-Base32 character/
    );
    // 'L' is also invalid in Crockford (replaced by '1').
    const bad2 = `L${ZERO_ULID.slice(1)}`;
    expect(() => ulidToBytes(bad2)).toThrow(
      /Invalid Crockford-Base32 character/
    );
    // Non-ASCII.
    const bad3 = `\u00ff${ZERO_ULID.slice(1)}`;
    expect(() => ulidToBytes(bad3)).toThrow(
      /Invalid Crockford-Base32 character/
    );
  });

  it("rejects ULIDs whose first character is > '7'", () => {
    // '8' = 0b01000, which has the top of its 3 real bits set... wait, '8'
    // has value 8 = 0b01000 in Crockford. The codec checks the top 2 pad
    // bits (values[0] & 0x18). 8 & 0x18 = 0x08, which is nonzero.
    const bad = `8${'0'.repeat(25)}`;
    expect(() => ulidToBytes(bad)).toThrow(/top 2 bits must be zero/);
    // 'Z' = 31 = 0b11111 → top 2 pad bits both set.
    const bad2 = `Z${'0'.repeat(25)}`;
    expect(() => ulidToBytes(bad2)).toThrow(/top 2 bits must be zero/);
  });

  it('throws on non-string inputs', () => {
    expect(() => ulidToBytes(undefined as unknown as string)).toThrow(
      TypeError
    );
    expect(() => ulidToBytes(null as unknown as string)).toThrow(TypeError);
    expect(() => ulidToBytes(123 as unknown as string)).toThrow(TypeError);
  });

  it('rejects wrong-length byte arrays', () => {
    expect(() => bytesToUlid(new Uint8Array(15))).toThrow(
      /Invalid byte length/
    );
    expect(() => bytesToUlid(new Uint8Array(17))).toThrow(
      /Invalid byte length/
    );
  });
});

describe('codec / isTaggedString', () => {
  it('returns false for the zero ULID', () => {
    expect(isTaggedString(ZERO_ULID)).toBe(false);
  });

  it('returns true for a ULID with the tag bit manually set', () => {
    const bytes = new Uint8Array(ULID_BYTE_LENGTH);
    bytes[0] = TAG_BIT_MASK;
    const tagged = bytesToUlid(bytes);
    expect(tagged).toBe('40000000000000000000000000');
    expect(isTaggedString(tagged)).toBe(true);
    // First char of a value with byte[0] = 0x80 should be '4' (0b100).
    expect(tagged[0]).toBe('4');
  });

  it('returns true for any ULID whose first char is in [4..7]', () => {
    expect(isTaggedString(`4${'0'.repeat(25)}`)).toBe(true);
    expect(isTaggedString(`5${'0'.repeat(25)}`)).toBe(true);
    expect(isTaggedString(`6${'0'.repeat(25)}`)).toBe(true);
    expect(isTaggedString(`7${'Z'.repeat(25)}`)).toBe(true);
    expect(isTaggedString(`0${'0'.repeat(25)}`)).toBe(false);
    expect(isTaggedString(`3${'Z'.repeat(25)}`)).toBe(false);
  });

  it('returns false for non-strings, wrong lengths, and invalid chars', () => {
    expect(isTaggedString('')).toBe(false);
    expect(isTaggedString('0'.repeat(25))).toBe(false);
    expect(isTaggedString(null)).toBe(false);
    expect(isTaggedString(undefined)).toBe(false);
    expect(isTaggedString(123)).toBe(false);
    expect(isTaggedString({})).toBe(false);
    // Invalid Crockford character at index 0.
    expect(isTaggedString(`U${ZERO_ULID.slice(1)}`)).toBe(false);
  });

  it('rejects ULIDs with invalid Crockford characters after index 0', () => {
    // First char '4' would otherwise set the tag bit, but the string is not
    // a valid ULID because of the bad char further in. A naive
    // implementation that only looked at the first char would incorrectly
    // return true here.
    expect(isTaggedString(`4${'U'.repeat(25)}`)).toBe(false);
    expect(isTaggedString(`4${'0'.repeat(24)}L`)).toBe(false);
  });

  it("rejects ULIDs whose first char is > '7' (overflows 128 bits)", () => {
    // First char '8'..'Z' has nonzero top 2 pad bits → not a valid ULID,
    // regardless of whether the tag bit appears set.
    expect(isTaggedString(`8${'0'.repeat(25)}`)).toBe(false);
    expect(isTaggedString(`Z${'0'.repeat(25)}`)).toBe(false);
  });
});
