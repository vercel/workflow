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
 * Runs at this spec version or later number their events by dense per-run slots
 * (`evnt_…001`) instead of ULIDs. Ids are minted by the client, and a write
 * that proposes an event id already taken is rejected rather than renumbered —
 * which is what lets a client prove its loaded log is complete.
 *
 * A run is in exactly one mode for life: the mode is read from the run's
 * persisted `specVersion`, never from the build. A run whose log holds ULID
 * event ids and is replayed by a slot-capable build would otherwise propose
 * `evnt_…001`, a position its very first event already occupies.
 *
 * Correlation ids are unrelated: steps, waits, hooks and attributes use seeded
 * ULIDs at every spec version.
 */
export const SPEC_VERSION_SLOT_IDENTITY = 6 as SpecVersion;

/**
 * Current spec version (event-sourced architecture with native attributes
 * and compressed payloads).
 *
 * The floor a world has to support, and a *lower* bar than the version worlds
 * stamp on the runs they create ({@link SPEC_VERSION_SLOT_IDENTITY}) or the
 * newest one this build can read ({@link SPEC_VERSION_MAX_SUPPORTED}).
 */
export const SPEC_VERSION_CURRENT =
  SPEC_VERSION_SUPPORTS_COMPRESSION as SpecVersion;

/**
 * Newest spec version this build can read. Runs above it are rejected outright
 * by {@link requiresNewerWorld} rather than misread.
 *
 * Distinct from {@link SPEC_VERSION_CURRENT} because a world reads further back
 * than the floor it requires, and because a world that stamps slot identity
 * still has to read the spec-5 runs it created before the switch.
 */
export const SPEC_VERSION_MAX_SUPPORTED =
  SPEC_VERSION_SLOT_IDENTITY as SpecVersion;

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

/**
 * Whether a run numbers its events by slot. Always pass the run's persisted
 * `specVersion`; see `SPEC_VERSION_SLOT_IDENTITY`.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run uses slot identity
 */
export function usesSlotIdentity(v: number | undefined | null): boolean {
  if (v === undefined || v === null) return false;
  return v >= SPEC_VERSION_SLOT_IDENTITY;
}
