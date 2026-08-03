/**
 * Region-tagged ULID encoding for Vercel workflow run IDs.
 *
 * A "tagged" run ID is a regular 26-character Crockford-Base32 ULID with:
 *
 *   - **Tag bit**: the MSB of byte 0 (the most-significant bit of the 48-bit
 *     timestamp) is set to 1, distinguishing this scheme from a plain ULID.
 *     This shifts the first character into the range `4`..`7`.
 *   - **Region ID** (6 bits, 0–63): encoded at the **top** of the 80-bit
 *     randomness section, in the high 6 bits of byte 6. Region IDs are
 *     assigned in {@link REGION_IDS}.
 *   - **Version** (5 bits, 0–31): encoded immediately below the region ID
 *     (high 2 bits in the bottom of byte 6, low 3 bits in the top of byte 7).
 *
 * Net effect: 80 bits of ULID randomness become 69 bits (still ~5.9 × 10²⁰
 * distinct values per millisecond), and the maximum representable timestamp
 * drops from year ~10895 down to year ~5429 — neither limit is practically
 * relevant.
 *
 * Tagged ULIDs remain valid ULIDs. Because the metadata sits at the **top**
 * of the randomness section, the bottom 69 bits are untouched by `encode`,
 * which means a `monotonicFactory()`-style ULID generator's same-millisecond
 * bottom-bit increments survive encoding intact. As a result:
 *
 *   - Lexicographic order is preserved across millisecond boundaries.
 *   - Intra-millisecond order is preserved when the metadata is held
 *     constant (i.e. consecutive `encode(ulid(), region, { version })` calls
 *     with the same `(region, version)` produce strictly increasing strings
 *     for as long as the underlying monotonic factory does).
 *
 * Changing the metadata mid-millisecond can still invert ordering relative
 * to a previous emission with different metadata; the {@link encode}
 * function itself does not enforce any ordering invariants — that is the
 * caller's responsibility (see the `createRunId` helper used by `start()`).
 *
 * @example
 * ```ts
 * import { monotonicFactory } from 'ulid';
 * import { encode, decode } from '@workflow/world-vercel/run-id';
 *
 * const ulid = monotonicFactory();
 * const taggedRunId = encode(ulid(), 'iad1');
 *
 * const { region, regionId, version } = decode(taggedRunId);
 * // region === 'iad1', regionId === 1, version === 1, tagged === true
 * ```
 *
 * @packageDocumentation
 */

import {
  bytesToUlid,
  isTaggedString,
  MAX_REGION,
  MAX_VERSION,
  REGION_BYTE_INDEX,
  REGION_MASK,
  TAG_BIT_MASK,
  ulidToBytes,
  VERSION_HIGH_MASK,
  VERSION_LOW_BYTE_INDEX,
  VERSION_LOW_MASK,
} from './codec.js';
import { lookupRegion, REGION_IDS, type RegionCode } from './regions.js';

export {
  lookupRegion,
  REGION_IDS,
  type RegionCode,
  type RegionId,
  type RegionKey,
  regionIdFor,
} from './regions.js';

/** Encoding format version currently emitted by {@link encode}. */
export const CURRENT_VERSION = 1;

export interface EncodeOptions {
  /**
   * Encoding format version to embed. Must be in the range 0..31. Defaults to
   * {@link CURRENT_VERSION} (1). Version 0 is reserved as a sentinel meaning
   * "no metadata encoded" — callers should not normally emit it.
   */
  version?: number;
}

/**
 * Common fields shared by both tagged and un-tagged decode results.
 */
interface DecodedRunIdBase {
  /**
   * The input ULID with **only the tag bit cleared**. For tagged inputs the
   * 11 metadata bits at the top of the randomness section (bytes 6–7) are
   * preserved verbatim. For un-tagged input this equals the input string
   * (uppercased).
   */
  ulid: string;
}

/**
 * Decode result for a ULID whose tag bit was set — the metadata fields
 * carry the values that `encode` wrote.
 */
export interface TaggedDecodedRunId extends DecodedRunIdBase {
  tagged: true;
  /** Encoded format version (0..31). */
  version: number;
  /** Encoded region ID (0..63). 0 represents "unknown". */
  regionId: number;
  /**
   * Region code (e.g. `'iad1'`) when {@link regionId} matches a known entry
   * in {@link REGION_IDS}, else `null`.
   */
  region: RegionCode | null;
}

/**
 * Decode result for a ULID whose tag bit was *not* set. The metadata
 * fields are `null` rather than populated with garbage bits, forcing
 * callers to discriminate on {@link tagged} before reading them.
 */
export interface UntaggedDecodedRunId extends DecodedRunIdBase {
  tagged: false;
  version: null;
  regionId: null;
  region: null;
}

/**
 * Discriminated union of the decode result; check `tagged` to narrow.
 */
export type DecodedRunId = TaggedDecodedRunId | UntaggedDecodedRunId;

function isRegionCode(value: unknown): value is RegionCode {
  return (
    typeof value === 'string' &&
    value !== 'unknown' &&
    Object.hasOwn(REGION_IDS, value)
  );
}

/**
 * Encode a region ID and version into a ULID, producing a 26-character
 * "tagged" ULID. The input ULID's top 11 randomness bits (the high bits
 * of byte 6 + the high bits of byte 7) and its timestamp MSB are
 * overwritten; the low 69 randomness bits are preserved intact.
 *
 * @param ulid - A valid 26-character Crockford-Base32 ULID.
 * @param region - Either a numeric region ID (0..63) or a known
 *   {@link RegionCode} (e.g. `'iad1'`).
 * @param options - See {@link EncodeOptions}.
 * @returns The tagged ULID, always uppercase.
 *
 * @throws If `ulid` is not a valid ULID string, if `region` is an unknown
 *   region code, if a numeric `region` is outside 0..63, or if
 *   `options.version` is outside 0..31.
 */
export function encode(
  ulid: string,
  region: number | RegionCode,
  options: EncodeOptions = {}
): string {
  // Resolve region → numeric ID.
  let regionId: number;
  if (typeof region === 'number') {
    if (!Number.isInteger(region) || region < 0 || region > MAX_REGION) {
      throw new RangeError(
        `regionId must be an integer in [0, ${MAX_REGION}]; got ${region}`
      );
    }
    regionId = region;
  } else if (isRegionCode(region)) {
    regionId = REGION_IDS[region];
  } else {
    throw new Error(`Unknown region: ${String(region)}`);
  }

  const version = options.version ?? CURRENT_VERSION;
  if (!Number.isInteger(version) || version < 0 || version > MAX_VERSION) {
    throw new RangeError(
      `version must be an integer in [0, ${MAX_VERSION}]; got ${version}`
    );
  }

  const bytes = ulidToBytes(ulid);

  // Set the tag bit.
  bytes[0] = bytes[0] | TAG_BIT_MASK;

  // Pack `regionId` (6 bits) into the top of byte[6] and the high 2 bits
  // of `version` into the bottom of byte[6]; the remaining low 3 bits of
  // `version` go into the top of byte[7]. The metadata sits at the **top**
  // of the 80-bit randomness section so that a monotonic ULID factory's
  // bottom-bit increments survive encoding intact.
  const regionShifted = (regionId & MAX_REGION) << 2; // 6 bits at bits 7..2
  const versionHigh = (version >> 3) & VERSION_HIGH_MASK; // top 2 bits at bits 1..0
  const versionLow = (version & 0x07) << 5; // low 3 bits at bits 7..5 of byte[7]

  bytes[REGION_BYTE_INDEX] =
    (bytes[REGION_BYTE_INDEX] & ~(REGION_MASK | VERSION_HIGH_MASK)) |
    regionShifted |
    versionHigh;
  bytes[VERSION_LOW_BYTE_INDEX] =
    (bytes[VERSION_LOW_BYTE_INDEX] & ~VERSION_LOW_MASK) | versionLow;

  return bytesToUlid(bytes);
}

/**
 * Decode a (possibly) tagged ULID. Always succeeds for any syntactically
 * valid ULID; check {@link DecodedRunId.tagged} to determine whether the
 * input was actually tagged by this scheme.
 *
 * The returned {@link DecodedRunId.ulid} has only the tag bit cleared — the
 * 11 metadata bits at the top of the randomness section remain in place, so
 * `decode(encode(u, r)).ulid` is *not* byte-identical to `u` (the top 11
 * randomness bits of `u` were overwritten by `encode`), but
 * `decode(encode(u, r)).ulid` is byte-identical to
 * `decode(encode(decode(encode(u, r)).ulid, r)).ulid`.
 *
 * @throws If the input is not a syntactically valid 26-character
 *   Crockford-Base32 ULID.
 */
export function decode(taggedUlid: string): DecodedRunId {
  const bytes = ulidToBytes(taggedUlid);
  const tagged = (bytes[0] & TAG_BIT_MASK) !== 0;

  // Clear the tag bit for the returned "untagged" ULID.
  bytes[0] = bytes[0] & ~TAG_BIT_MASK;
  const ulid = bytesToUlid(bytes);

  if (!tagged) {
    // For un-tagged input, the bits in the metadata positions are
    // arbitrary randomness from the source ULID. Surfacing them as `null`
    // forces callers to discriminate on `tagged` before reading them.
    return { tagged: false, ulid, version: null, regionId: null, region: null };
  }

  // Pull `regionId` from the top 6 bits of byte[6] and the 5-bit `version`
  // from the low 2 bits of byte[6] + the high 3 bits of byte[7].
  const regionId = (bytes[REGION_BYTE_INDEX] & REGION_MASK) >> 2;
  const version =
    ((bytes[REGION_BYTE_INDEX] & VERSION_HIGH_MASK) << 3) |
    ((bytes[VERSION_LOW_BYTE_INDEX] & VERSION_LOW_MASK) >> 5);

  return {
    tagged: true,
    ulid,
    version,
    regionId,
    region: lookupRegion(regionId),
  };
}

/**
 * Returns `true` if `value` is a 26-character Crockford-Base32 ULID with the
 * tag bit set (i.e. was produced by {@link encode}). Returns `false` for any
 * input that is not a syntactically valid ULID, including non-strings.
 *
 * The parameter is typed as `unknown` so this function can safely be used as
 * a guard on untrusted input without requiring callers to cast.
 */
export function isTagged(value: unknown): boolean {
  return isTaggedString(value);
}

// Re-export internal constants that may be useful for callers wanting to
// reason about the encoding's bit budget without importing from a deep path.
export { MAX_REGION as MAX_REGION_ID, MAX_VERSION } from './codec.js';
