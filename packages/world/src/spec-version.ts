/**
 * Spec version utilities for backward compatibility.
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
 * This is the only true legacy version: specVersion 2+ all use the event-sourced model.
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
 * so concurrent writers never race each other for a position. A position
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
 * Runs at this spec version or later understand an INVOLUNTARY hook disposal:
 * a `hook_disposed` carrying `forceClaimedBy`, written into the run's log by
 * another run's `createHook({ experimental_force: true })`. A reader at this
 * version rejects the hook's awaiters with `HookForceClaimedError` and settles
 * `getConflict()`; a reader below it treats the row as its own `dispose()`
 * and leaves every `await hook` pending forever — the run is not corrupted,
 * but it is silently stranded. Like the sealed log, this is a READER contract,
 * and the version is what lets a World tell the two readers apart: a World
 * only takes a token from a running victim stamped at or above this version,
 * and answers the forced creation with an ordinary `hook_conflict`
 * (`forceRefusedReason: 'victim-spec-version'`) otherwise. A finished victim
 * has no reader to strand, so a retained token is taken over at any version.
 *
 * The Python SDK stamps its own spec versions below this one, so a Python
 * run's token can never be taken over — its runtime knows nothing of
 * `forceClaimedBy` either.
 */
export const SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM = 8 as SpecVersion;

/**
 * Runs at this spec version or later follow the single-orchestrator model:
 * one orchestrator invocation per run makes every decision, step and wait
 * events are plain appends to the log (a World keeps no step or wait state it
 * checks writes against), and the orchestrator's own writes are fenced.
 *
 * What changes for a reader and a writer:
 *
 * - Every write request says whether the run's orchestrator made it
 *   (`CreateEventParams.inBand`). An in-band write carries the orchestrator's
 *   count of in-band positions (`expectedSeqInBand`), taken from the
 *   `snapshot` its log load returned. The World refuses an in-band write
 *   whose count is stale with
 *   `InBandSupersededError`, which makes at most one orchestrator a writer
 *   even when two invocations of it run at once. Every World implements
 *   this fence (`WorldCapabilities.inBandFence`).
 * - `step_created` records how the step executes (`eventData.inline`) and
 *   which queue message's invocation created it (`creatorMessageId`). Step
 *   events carry `stepName`, and `step_started` carries `attempt` and
 *   `startReason`.
 * - Replay treats any event for an entity after its terminal event as inert.
 *
 * Structural: positions are counted against an in-band head, and step state
 * is folded from the log instead of read from a row, so a run can only be
 * moved across this version before anything past `run_created` exists.
 *
 * It requires the sealed log: the fence counts positions the World's
 * sequencer allocates, so it builds on {@link SPEC_VERSION_SUPPORTS_SEALED_LOG}.
 */
export const SPEC_VERSION_SINGLE_ORCHESTRATOR = 9 as SpecVersion;

/**
 * Current spec version: event-sourced architecture with native attributes,
 * compressed payloads, slot-numbered event ids, sealed-log sequencing,
 * involuntary hook disposal, and the single-orchestrator model.
 *
 * This is the version a World stamps on the runs it creates (see
 * {@link mintedSpecVersion}). The lowest version this runtime accepts from a
 * World is lower: see `assertWorldSupportsRuntimeProtocol` in
 * `@workflow/core`, which floors at {@link SPEC_VERSION_SUPPORTS_SLOT_IDENTITY}.
 *
 * A World declares `mintedSpecVersion()` rather than a literal, so a bump
 * moves the declaration with the package. Pinning a literal would leave the
 * adapter one version behind the next bump.
 *
 * Bumping this does not touch runs already created: their stamped version is
 * persisted, every version test in the runtime is `>=`, and a World resolves a
 * run's identity scheme from what is stored rather than from this constant.
 */
export const SPEC_VERSION_CURRENT =
  SPEC_VERSION_SINGLE_ORCHESTRATOR as SpecVersion;

/**
 * The spec version a World should stamp on the runs it creates: always
 * {@link SPEC_VERSION_CURRENT}.
 *
 * There is no opt-out. Earlier releases read `WORKFLOW_SEALED_LOG=0` here to
 * mint slot-identity runs instead of sealed-log runs. The single-orchestrator
 * version requires the sealed log (its fence counts sequencer allocations), and
 * this runtime only implements the single-orchestrator model, so minting a
 * lower version would create runs this runtime does not know how to drive.
 * The variable is no longer read. A deployment that has to stay on an earlier
 * scheme stays on the SDK release that implements it; skew protection keeps
 * every in-flight run on the deployment that created it.
 *
 * Kept a function, and the `env` parameter kept, so Worlds that call it in
 * `createWorld()` keep compiling and keep moving with this package.
 */
export function mintedSpecVersion(
  _env: Record<string, string | undefined> = process.env
): SpecVersion {
  return SPEC_VERSION_CURRENT;
}

/**
 * The highest spec version this SDK can read.
 *
 * Kept distinct from `SPEC_VERSION_CURRENT` even when they coincide. They
 * answer different questions, "what do we write?" versus "what can we still
 * read?", and they come apart in exactly the release order a spec bump
 * follows: a reader that can already handle the next version raises this
 * ceiling first, and stamping follows only once the version is safe to mint
 * everywhere.
 */
export const SPEC_VERSION_MAX_SUPPORTED =
  SPEC_VERSION_SINGLE_ORCHESTRATOR as SpecVersion;

/**
 * Spec versions whose only effect is to switch on capabilities of a run's
 * reader and writer, which is the runtime executing it. A backend may raise
 * a running run across these (to its executor's attested version, see
 * `executorSpecVersion` on `run_started`), because nothing already in the
 * run's log changes meaning.
 *
 * Every other version is STRUCTURAL: it changes how the log is laid out or
 * read (event sourcing itself, slot-numbered event ids, sealed-log
 * sequencing), so a run may only be moved across it before any event past
 * `run_created` exists. That includes versions not listed here yet: an
 * unclassified future version is structural by default, and adding a
 * version constant without classifying it fails this package's tests.
 */
export const CAPABILITY_ONLY_SPEC_VERSIONS: ReadonlySet<number> = new Set([
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
]);

/** The structural spec versions; see {@link CAPABILITY_ONLY_SPEC_VERSIONS}. */
export const STRUCTURAL_SPEC_VERSIONS: ReadonlySet<number> = new Set([
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
]);

/**
 * Whether moving a run from spec version `from` up to `to` crosses a
 * structural version, and so is only allowed while the run's log holds
 * nothing but `run_created`. See {@link CAPABILITY_ONLY_SPEC_VERSIONS}.
 */
export function crossesStructuralSpecVersion(
  from: number,
  to: number
): boolean {
  for (let v = from + 1; v <= to; v++) {
    if (!CAPABILITY_ONLY_SPEC_VERSIONS.has(v)) return true;
  }
  return false;
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
