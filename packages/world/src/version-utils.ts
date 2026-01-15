import semver from 'semver';

/**
 * The version at which event-sourcing was introduced.
 * Runs created with this version or later use event-sourced architecture.
 */
export const EVENT_SOURCED_VERSION = '4.1.0-beta.0';

/**
 * Returns true if the version is < 4.1.0 (legacy/pre-event-sourcing).
 * Legacy runs require different handling for certain operations.
 *
 * @param v - The spec version string, or undefined for runs without a version
 * @returns true if the version is legacy (pre-event-sourcing)
 */
export function isLegacyVersion(v: string | undefined): boolean {
  if (!v) return true;
  return semver.lt(v, EVENT_SOURCED_VERSION);
}
