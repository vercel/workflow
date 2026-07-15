import { monotonicFactory } from 'ulid';
import { bytesToUlid, ulidToBytes } from './run-id/codec.js';
import { decode, encode } from './run-id/index.js';
import {
  DEFAULT_REGION_CODE,
  REGION_IDS,
  type RegionCode,
} from './run-id/regions.js';

/**
 * Underlying monotonic ULID factory. {@link encode} overwrites only the
 * top 11 bits of the randomness section, so the factory's same-millisecond
 * bottom-bit increments survive encoding and consecutive IDs with the same
 * region/version metadata are naturally monotonic. The per-process check in
 * {@link createRunId} exists for the remaining edge case: the metadata
 * changing (e.g. a different `region`) within a single millisecond.
 */
const ulid = monotonicFactory();

/**
 * Last emitted run ID (the encoded/tagged form), used to enforce strict
 * lexicographic monotonicity across calls within a single process even
 * when the region/version metadata changes between same-millisecond calls.
 */
let lastRunId: string | undefined;

/**
 * Increment the bit immediately above the 11-bit metadata window of a
 * 26-char tagged ULID. The metadata occupies the top 11 bits of the
 * randomness section (all of byte 6 + the top 3 bits of byte 7), so the
 * next bit up is the lowest bit of the 48-bit timestamp (byte 5) — the
 * result is effectively the same ULID time-stamped 1ms later. This lets
 * us produce a strictly-larger ULID regardless of what region/version
 * metadata is subsequently stamped on top.
 *
 * Throws if the ULID is at its maximum value (timestamp would overflow).
 */
function bumpAboveMetadata(ulidStr: string): string {
  const bytes = ulidToBytes(ulidStr);
  let i = 5;
  let carry = 0x01;
  while (i >= 0 && carry > 0) {
    const sum = bytes[i] + carry;
    bytes[i] = sum & 0xff;
    carry = sum >> 8;
    i--;
  }
  if (carry > 0) {
    // 48-bit timestamp space exhausted — astronomically unlikely.
    throw new Error('ULID space exhausted');
  }
  return bytesToUlid(bytes);
}

/**
 * Coerce an arbitrary value into a known {@link RegionCode}, returning
 * `null` for anything that isn't a string matching a real region entry in
 * {@link REGION_IDS} (the `'unknown'` sentinel is explicitly excluded so
 * callers can't accidentally supply it).
 */
function coerceRegion(value: unknown): RegionCode | null {
  if (typeof value !== 'string' || value === '' || value === 'unknown') {
    return null;
  }
  return Object.hasOwn(REGION_IDS, value) ? (value as RegionCode) : null;
}

/**
 * Resolve the effective region for a run, preferring an explicit value
 * supplied via the `start()` options bag over the `VERCEL_REGION`
 * environment variable. Falls back to {@link DEFAULT_REGION_CODE} (iad1)
 * when neither source yields a recognised region, so a run ID is always
 * tagged with a concrete, routable region rather than the `unknown` (0)
 * sentinel — matching the server's default-region resolution.
 */
function resolveRegion(
  options: Readonly<Record<string, unknown>> | undefined
): RegionCode {
  return (
    coerceRegion(options?.region) ??
    coerceRegion(process.env.VERCEL_REGION) ??
    DEFAULT_REGION_CODE
  );
}

/**
 * `World.createRunId` implementation that mints region-tagged ULIDs.
 *
 * Region resolution order (first non-empty wins):
 *   1. `options.region` — explicit caller-supplied region forwarded by
 *      `start({ region })`.
 *   2. `process.env.VERCEL_REGION` — the region the current Vercel function
 *      is executing in.
 *   3. {@link DEFAULT_REGION_CODE} (iad1) — the server-side default region.
 *      A run ID is therefore always tagged with a concrete, routable region;
 *      the `unknown` (0) sentinel is never minted here.
 *
 * Monotonicity: `encode` writes the region/version metadata into the top
 * 11 bits of the randomness section, leaving the low 69 bits intact, so
 * the underlying monotonic factory keeps consecutive same-metadata IDs
 * strictly increasing on its own. The remaining hazard is the metadata
 * changing between same-millisecond calls (a lower-numbered region sorts
 * below a higher one at the same timestamp), so we track the last emitted
 * ID and, on collision, bump the candidate above the metadata window
 * before re-stamping the requested region/version.
 */
export function createRunId(
  options?: Readonly<Record<string, unknown>>
): string {
  const region = resolveRegion(options);
  const regionId = REGION_IDS[region];
  let candidate = encode(ulid(), regionId);
  if (lastRunId !== undefined) {
    while (candidate <= lastRunId) {
      candidate = encode(bumpAboveMetadata(lastRunId), regionId);
    }
  }
  lastRunId = candidate;
  return candidate;
}

/**
 * Derive the region a run's data lives in from its run ID.
 *
 * - Region-tagged IDs (minted by {@link createRunId}) decode to their
 *   embedded region.
 * - Untagged legacy IDs — and tagged IDs whose region code is unknown to
 *   this SDK version — resolve to {@link DEFAULT_REGION_CODE}: all
 *   pre-tagging data lives there by convention, matching the backend's
 *   routing.
 * - Malformed IDs return `null` (never throws).
 */
export function regionForRunId(runId: string): string | null {
  const bare = runId.startsWith('wrun_') ? runId.slice('wrun_'.length) : runId;
  try {
    const decoded = decode(bare);
    return decoded.tagged && decoded.region
      ? decoded.region
      : DEFAULT_REGION_CODE;
  } catch {
    return null;
  }
}

/**
 * `World.describeRun` implementation: Vercel-specific display fields
 * for a run.
 *
 * Currently a single field — `region`, decoded from the run ID's
 * region tag (see {@link regionForRunId}) — but the shape leaves room
 * for additional fields derived from other run-entity properties
 * (e.g. `executionContext`) without another interface change. A
 * `null` region means the run ID was present but undecodable;
 * a missing/non-string run ID contributes nothing.
 */
export function describeRun(
  run: Readonly<Record<string, unknown>>
): Record<string, string | null> | null {
  const runId = run.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    return null;
  }
  return { region: regionForRunId(runId) };
}
