/**
 * Stable mapping between Vercel compute region codes (e.g. `iad1`) and the
 * 6-bit region IDs encoded into tagged workflow run IDs.
 *
 * **DO NOT REORDER OR REUSE IDS.** Once a region has been assigned an ID, that
 * ID is part of the on-the-wire encoding of every run ID ever issued for that
 * region. New regions must be appended with the next unused ID.
 *
 * `0` is reserved for "unknown" — encode functions may emit it when the
 * caller's region cannot be determined, and decode will surface it as
 * `region: null`.
 *
 * The list below covers the 21 currently-deployed Vercel compute regions plus
 * `hel1` and `zrh1`, which are reserved for future rollout so they can be
 * assigned without requiring a version bump.
 */
export const REGION_IDS = {
  unknown: 0,
  iad1: 1,
  sfo1: 2,
  pdx1: 3,
  cle1: 4,
  yul1: 5,
  gru1: 6,
  dub1: 7,
  lhr1: 8,
  cdg1: 9,
  fra1: 10,
  bru1: 11,
  arn1: 12,
  hel1: 13,
  zrh1: 14,
  cpt1: 15,
  dxb1: 16,
  bom1: 17,
  sin1: 18,
  hkg1: 19,
  hnd1: 20,
  icn1: 21,
  kix1: 22,
  syd1: 23,
} as const;

/**
 * Any key in {@link REGION_IDS}, including the `'unknown'` sentinel. Not
 * usually what callers want — see {@link RegionCode} for the "known region"
 * subset.
 */
export type RegionKey = keyof typeof REGION_IDS;

/**
 * A concrete Vercel compute region code (e.g. `'iad1'`, `'fra1'`). Excludes
 * the `'unknown'` sentinel since it does not correspond to any real region.
 */
export type RegionCode = Exclude<RegionKey, 'unknown'>;

export type RegionId = (typeof REGION_IDS)[RegionKey];

/**
 * Reverse map: numeric region ID → region code. Only populated for known
 * regions (i.e. excludes the `unknown`/0 sentinel); {@link lookupRegion}
 * returns `null` for any ID not present in this map.
 */
const REGION_CODES_BY_ID: ReadonlyMap<number, RegionCode> = new Map(
  (Object.entries(REGION_IDS) as Array<[RegionKey, number]>)
    .filter((entry): entry is [RegionCode, number] => entry[0] !== 'unknown')
    .map(([code, id]) => [id, code])
);

/**
 * Look up a region code by ID. Returns `null` for IDs not in {@link REGION_IDS}
 * and for the `unknown`/0 sentinel.
 */
export function lookupRegion(regionId: number): RegionCode | null {
  return REGION_CODES_BY_ID.get(regionId) ?? null;
}

/**
 * Look up a numeric region ID by code. The TypeScript signature requires a
 * known {@link RegionCode}, but the function still validates at runtime
 * for callers crossing a JS/TS boundary where the input may be any string.
 */
export function regionIdFor(code: RegionCode): RegionId {
  const id = REGION_IDS[code];
  /* c8 ignore next 3 -- defensive runtime backstop; unreachable in well-typed TS */
  if (id === undefined) {
    throw new Error(`Unknown Vercel region code: ${String(code)}`);
  }
  return id;
}
