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

/** Legacy spec version (pre-event-sourcing). Also used for runs without specVersion. */
export const SPEC_VERSION_LEGACY = 1 as SpecVersion;

/** Current spec version (event-sourced architecture). */
export const SPEC_VERSION_CURRENT = 2 as SpecVersion;

/**
 * Check if a spec version is legacy (< SPEC_VERSION_CURRENT or undefined).
 * Legacy runs require different handling - they use direct entity mutation
 * instead of the event-sourced model.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run is a legacy run
 */
export function isLegacySpecVersion(v: number | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  return v < SPEC_VERSION_CURRENT;
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
