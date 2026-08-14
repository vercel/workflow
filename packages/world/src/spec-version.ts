/**
 * Spec version utilities for backwards compatibility.
 *
 * Uses a branded type to ensure packages import the version constants
 * from @workflow/world rather than using arbitrary numbers.
 */

declare const SpecVersionBrand: unique symbol;

/**
 * Branded type for spec versions. Must be created via SPEC_VERSION constants.
 * This ensures all packages use the canonical version from @workflow/world.
 */
export type SpecVersion = number & {
  readonly [SpecVersionBrand]: typeof SpecVersionBrand;
};

/**
 * Legacy spec version (pre-event-sourcing). Also used for runs without specVersion.
 * This is the only true legacy version — specVersion 2+ all use the event-sourced model.
 */
export const SPEC_VERSION_LEGACY = 1 as SpecVersion;

export const SPEC_VERSION_SUPPORTS_EVENT_SOURCING = 2 as SpecVersion;
export const SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT = 3 as SpecVersion;
export const SPEC_VERSION_SUPPORTS_ATTRIBUTES = 4 as SpecVersion;
/**
 * Runs at this spec version or later may contain zstd- or gzip-compressed
 * payloads. Readers older than this version reject the run via
 * `requiresNewerWorld()` instead of failing on individual payloads.
 */
export const SPEC_VERSION_SUPPORTS_COMPRESSION = 5 as SpecVersion;

/**
 * Runs at this spec version get slot-numbered event ids: `evnt_` followed by a
 * zero-padded decimal position, dense and contiguous from 1 within one run.
 *
 * This exists for Worlds that cannot read a run's scheme off its own storage.
 * `world-local` and `world-postgres` own the counter that mints the ids, so
 * they know per run which scheme it started under. `world-vercel` writes
 * through an API whose allocator has to make that decision on each request,
 * and the spec version stamped on `run_created` is what carries it. A run
 * created before the backend adopted slots stays on ULIDs for its whole life
 * because its stamped version is below this one.
 */
export const SPEC_VERSION_SUPPORTS_SLOT_IDENTITY = 6 as SpecVersion;

/**
 * Current spec version (event-sourced architecture with native attributes
 * and compressed payloads).
 *
 * Deliberately NOT bumped for slot-numbered event ids. Slot numbering is a
 * property of a run's whole log rather than of an individual event, and it is
 * already self-describing: a run's scheme is readable from the shape of its
 * own first event id (see `isSlotEventId`), so a World that owns its own id
 * allocation needs no version negotiation to pin one. Bumping this constant
 * would stamp the new version on every World
 * including ones that have not adopted slots yet, which is exactly the
 * cross-version breakage the pin exists to avoid. A World that does allocate
 * slots declares the higher version itself (see `world-vercel`), and
 * `SPEC_VERSION_MAX_SUPPORTED` is what keeps this reader from rejecting the
 * runs it produces.
 */
export const SPEC_VERSION_CURRENT =
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY as SpecVersion;

/**
 * The highest spec version this SDK can read.
 *
 * Distinct from `SPEC_VERSION_CURRENT`, which is the *default* a World stamps
 * on runs it creates. A World may declare a higher version than the default,
 * so the "was this run made by a newer SDK?" test has to be against the
 * ceiling: comparing against the default would make the SDK reject runs its
 * own adapters just created.
 */
export const SPEC_VERSION_MAX_SUPPORTED =
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY as SpecVersion;

/**
 * Check if a spec version is legacy (<= SPEC_VERSION_LEGACY or undefined).
 * Legacy runs require different handling - they use direct entity mutation
 * instead of the event-sourced model.
 *
 * Checks against SPEC_VERSION_LEGACY (1), not SPEC_VERSION_CURRENT, so that
 * intermediate versions (e.g. 2) are not incorrectly treated as legacy when
 * SPEC_VERSION_CURRENT is bumped.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run is a legacy run
 */
export function isLegacySpecVersion(v: number | undefined | null): boolean {
  return v === undefined || v === null || v <= SPEC_VERSION_LEGACY;
}

/**
 * Check if a spec version requires a newer world (> SPEC_VERSION_MAX_SUPPORTED).
 * This happens when a run was created by a newer SDK version.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run requires a newer world version
 */
export function requiresNewerWorld(v: number | undefined | null): boolean {
  if (v === undefined || v === null) return false;
  return v > SPEC_VERSION_MAX_SUPPORTED;
}
