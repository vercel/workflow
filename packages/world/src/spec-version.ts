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
 * Runs at this spec version or later number their events, and their step and
 * wait correlation ids, by dense per-run slots (`evnt_…001`, `step_…001`)
 * instead of ULIDs. Ids are minted by the client, and a write that proposes an
 * event id already taken is rejected rather than renumbered — which is what
 * lets a client prove its loaded log is complete.
 *
 * A run is in exactly one mode for life: the mode is read from the run's
 * persisted `specVersion`, never from the build. A run started under ULID
 * correlation ids and replayed by a slot-capable build would otherwise propose
 * `step_…001` where its log holds `step_01K…`, matching no existing entity.
 */
export const SPEC_VERSION_SLOT_IDENTITY = 6 as SpecVersion;

/**
 * Current spec version (event-sourced architecture with native attributes
 * and compressed payloads).
 *
 * This is the version new runs are stamped with, which is a *lower* bar than
 * the newest version this build can read — see
 * {@link SPEC_VERSION_MAX_SUPPORTED}. Slot identity ships behind a flag, so it
 * is readable everywhere before it is minted anywhere.
 */
export const SPEC_VERSION_CURRENT =
  SPEC_VERSION_SUPPORTS_COMPRESSION as SpecVersion;

/**
 * Newest spec version this build can read. Runs above it are rejected outright
 * by {@link requiresNewerWorld} rather than misread.
 *
 * Distinct from {@link SPEC_VERSION_CURRENT} because a world has to be able to
 * read a version before anything may mint it: the flag that turns slot identity
 * on for new runs would otherwise make every world reject the runs it had just
 * created. Worlds opt into minting individually, via the `specVersion` they
 * declare.
 */
export const SPEC_VERSION_MAX_SUPPORTED =
  SPEC_VERSION_SLOT_IDENTITY as SpecVersion;

/**
 * Environment variable that opts new runs into slot identity.
 *
 * Read per `createWorld()` call rather than at module load, so a test or a
 * single process can create worlds in both modes.
 */
export const SLOT_IDENTITY_ENV_VAR = 'WORKFLOW_SLOT_IDENTITY';

/**
 * The spec version a world should stamp on the runs it creates: slot identity
 * when {@link SLOT_IDENTITY_ENV_VAR} is set, otherwise
 * {@link SPEC_VERSION_CURRENT}.
 *
 * Every world reads runs up to {@link SPEC_VERSION_MAX_SUPPORTED} whatever this
 * returns, so turning the flag on in one place does not make the runs it creates
 * unreadable elsewhere.
 */
export function mintedSpecVersion(
  env: Record<string, string | undefined> = process.env
): SpecVersion {
  const value = env[SLOT_IDENTITY_ENV_VAR];
  return value === '1' || value === 'true'
    ? SPEC_VERSION_SLOT_IDENTITY
    : SPEC_VERSION_CURRENT;
}

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
 * Whether a run numbers its events and correlation ids by slot. Always pass the
 * run's persisted `specVersion`; see `SPEC_VERSION_SLOT_IDENTITY`.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run uses slot identity
 */
export function usesSlotIdentity(v: number | undefined | null): boolean {
  if (v === undefined || v === null) return false;
  return v >= SPEC_VERSION_SLOT_IDENTITY;
}
