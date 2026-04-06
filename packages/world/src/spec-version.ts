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

/** Current spec version (event-sourced architecture with CBOR queue transport). */
export const SPEC_VERSION_CURRENT =
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT as SpecVersion;

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
 * Check if a spec version requires a newer world (> SPEC_VERSION_CURRENT).
 * This happens when a run was created by a newer SDK version.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run requires a newer world version
 */
export function requiresNewerWorld(v: number | undefined | null): boolean {
  if (v === undefined || v === null) return false;
  return v > SPEC_VERSION_CURRENT;
}
