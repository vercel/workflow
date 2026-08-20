/**
 * Spec version utilities for backwards compatibility.
 *
 * Uses a branded type to ensure packages import the version constants
 * from @workflow/world rather than using arbitrary numbers.
 */

import { envFlag } from './env-config.js';

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
 *
 * Slots are no longer optional for a World: the runtime reads a position out
 * of every event id it loads (`requireEventSlot`) and fails the run if it
 * cannot. That makes this version the lowest one this runtime can serve at
 * all. See `SPEC_VERSION_CURRENT`.
 */
export const SPEC_VERSION_SUPPORTS_SLOT_IDENTITY = 6 as SpecVersion;

/**
 * Runs at this spec version or later live in a "sealed log": their slot
 * positions are pre-assigned by a per-run sequencer on the World's backend,
 * so concurrent writers never race each other for a position — and a position
 * whose writer died is filled ("sealed") by the backend with a `noop` event.
 * What the version gates is the READER contract that makes that safe: a
 * reader at this version knows a `noop` occupies its slot and carries no
 * workflow meaning, and skips it during replay without advancing the
 * deterministic clock (see `EventsConsumer`). A reader below this version
 * would fail to parse the unknown event type, which is exactly what
 * `requiresNewerWorld` exists to catch.
 *
 * Note this is the READER contract only, so a World is spec-7 compliant by
 * construction if it allocates each position at the commit that occupies it:
 * no write can then leave a position empty, so it has no holes to seal and
 * will never emit a `noop`. Pre-assigning positions ahead of the commit is
 * what creates the obligation (see `building-a-world.mdx`), and only a World
 * that does so needs the sealing half.
 */
export const SPEC_VERSION_SUPPORTS_SEALED_LOG = 7 as SpecVersion;

/**
 * Current spec version: event-sourced architecture with native attributes,
 * compressed payloads, slot-numbered event ids, and sealed-log sequencing.
 *
 * This is both the version a World stamps on the runs it creates and the
 * *lowest* one this runtime accepts from a World (see
 * `assertWorldSupportsRuntimeProtocol`). Slot numbering is a requirement of
 * the World contract rather than a capability to opt into: a World declaring
 * anything below this allocates event ids the runtime cannot read positions
 * out of, so admitting it would only move the failure from startup to the
 * middle of a run.
 *
 * This is the FLOOR, not necessarily what gets stamped. Sealed-log runs sit
 * one version above it and are opt-in, so what a World actually stamps comes
 * from {@link mintedSpecVersion}; this is what that falls back to.
 *
 * A World therefore declares this constant rather than a literal, so a bump
 * moves the declaration and the floor together. Pinning a literal would leave
 * the adapter one version behind the next bump and get it rejected by the
 * runtime it ships alongside.
 *
 * Bumping this does not touch runs already created: their stamped version is
 * persisted, every version test in the runtime is `>=`, and a World resolves a
 * run's identity scheme from what is stored rather than from this constant.
 */
export const SPEC_VERSION_CURRENT =
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY as SpecVersion;

/**
 * Environment variable that opts new runs INTO the sealed log.
 *
 * Read per `createWorld()` call rather than at module load, so a test or a
 * single process can create worlds in both modes.
 */
export const SEALED_LOG_ENV_VAR = 'WORKFLOW_SEALED_LOG';

/**
 * The spec version a World should stamp on the runs it creates.
 *
 * Sealed-log runs are opt-in for now, so this answers
 * {@link SPEC_VERSION_CURRENT} unless {@link SEALED_LOG_ENV_VAR} turns it on.
 * Same shape, and the same reasoning, as the flag slot identity itself shipped
 * behind before going unconditional.
 *
 * Opt-in rather than opt-out because stamping a version is not a local
 * decision: it changes what every OTHER reader of the run has to understand.
 * A spec-7 log may contain `noop` rows, and a reader that does not know to
 * skip them cannot replay it — which includes readers that are not this
 * package and do not ship on its release train. The Python runtime pins its
 * own accepted range and rejects 7 outright today, so a default-on bump takes
 * every Python workflow down the moment this is published, with no way back
 * except another release. Default-off makes the rollout a deployment setting:
 * turn it on where the backend seals and every reader of those runs
 * understands noops, leave it off everywhere else.
 *
 * Every World reads runs up to {@link SPEC_VERSION_MAX_SUPPORTED} whatever
 * this returns, so turning the flag off here does not make runs another
 * process created unreadable.
 */
export function mintedSpecVersion(
  env: Record<string, string | undefined> = process.env
): SpecVersion {
  return envFlag(SEALED_LOG_ENV_VAR, false, env)
    ? SPEC_VERSION_SUPPORTS_SEALED_LOG
    : SPEC_VERSION_CURRENT;
}

/**
 * The highest spec version this SDK can read.
 *
 * Kept distinct from `SPEC_VERSION_CURRENT`, and right now they genuinely
 * differ. They answer different questions, "what do we write?" versus "what
 * can we still read?", and they come apart in exactly the release order a spec
 * bump follows: a reader that can already handle the next version raises this
 * ceiling first, and stamping follows only once the version is safe to mint
 * everywhere. Sealed-log support is at that first stage — every build reads
 * spec 7 and skips `noop`, while {@link mintedSpecVersion} still has to be
 * turned on before anything creates a spec-7 run.
 */
export const SPEC_VERSION_MAX_SUPPORTED =
  SPEC_VERSION_SUPPORTS_SEALED_LOG as SpecVersion;

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
