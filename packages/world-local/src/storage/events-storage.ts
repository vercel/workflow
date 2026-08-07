import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  Hook,
  HookCreatedEventRequest,
  ResolveData,
  SerializedData,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import {
  applyAttributeChanges,
  awaitedResolutionMessage,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  findAwaitedResolution,
  HookSchema,
  isChildEntityCreationEvent,
  isHookEventRequiringExistence,
  isHookLifecycleEventType,
  isLegacySpecVersion,
  isSlotEventId,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  slotToEventId,
  ulidToDate,
  validateAttributeChanges,
  validateUlidTimestamp,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { z } from 'zod';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  deleteJSON,
  jsonReplacer,
  jsonReviver,
  listJSONFiles,
  paginatedFileSystemQuery,
  promoteExclusive,
  readJSON,
  readJSONWithFallback,
  resolveWithinBase,
  SORT_KEY_CURSOR_PREFIX,
  taggedPath,
  write,
  writeExclusive,
  writeJSON,
} from '../fs.js';
import { stripEventDataRefs } from './filters.js';
import {
  getObjectCreatedAt,
  type HookTokenClaim,
  hookDisposeLockPath,
  hookRecoveryMarkerPath,
  hookResumeClaimPath,
  hookTokenClaimPath,
  isHookDisposalCommitted,
  isRunTerminalCommitted,
  mintRunDominantEventKey,
  monotonicUlid,
  pendingHookEventPath,
  type RunEventIdScan,
  readHookTokenClaim,
  reapPendingHookEvents,
  releaseHookTokenClaimIfOwnedBy,
  runTerminalMarkerPath,
  scanRunEventIds,
  withHookTokenClaimLock,
} from './helpers.js';
import {
  deleteHookByRunMarker,
  writeHookByRunMarker,
  writeHookCreatedIndexEntries,
} from './hook-index.js';
import {
  deleteAllHooksForRun,
  hookFromCreatedEvent,
  rebuildLiveHookByTokenFromEventLog,
} from './hooks-storage.js';
import { handleLegacyEvent } from './legacy.js';
import { withRunFileLock } from './runs-storage.js';

/**
 * Per-run event ceiling the Local World reports on run responses (mirrors the
 * Vercel World). Overridable via `WORKFLOW_MAX_EVENTS`; defaults to 25,000.
 */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/**
 * How far above a writer's snapshot the awaited-resolution fence reads. A
 * suspension that missed more events than this has bigger problems than the
 * fence, and the read is on the hot path of every guarded write.
 */
const AWAITED_RESOLUTION_SCAN_LIMIT = 200;
function getMaxEventsPerRun(): number {
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_EVENTS_PER_RUN;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function getHookRetentionLimitMs(): number {
  const days = Number(
    process.env.WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS ?? 30
  );
  if (!Number.isFinite(days) || days <= 0) {
    throw new WorkflowWorldError(
      'WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS must be a positive number',
      { status: 400 }
    );
  }
  return days * DAY_MS;
}

/**
 * Per-step in-process async mutex. Serializes concurrent `events.create` calls
 * that target the same step, so that the "check terminal state, then write step
 * entity + event" sequence is atomic. Without this, two concurrent step_started
 * calls can both pass the not-terminal check and both write step_started events
 * — or a step_started can land in the log after step_completed has already
 * written, producing unconsumed events on replay.
 *
 * Duplicate step_started events for a non-terminal step are still allowed
 * (retries legitimately re-start a step), only writes to an already-terminal
 * step are rejected.
 */
// `stepLocks` and `hookLocks` are now instantiated per
// `createEventsStorage` call (see inside the function) rather than
// being module-level. Claim files remain the durable ownership record;
// cross-process Hook token handoffs use `withHookTokenClaimLock`.

/**
 * Sidecar recovery marker that pins a canonical `hook_created`
 * eventId for a legacy token claim — one written by a version of
 * this storage that did not yet persist `eventId` inline in the
 * claim file. Without this marker, two cross-process retries
 * reading a legacy claim each generate their own eventId, land
 * their `writeExclusive(eventPath)` calls at different paths, and
 * append two `hook_created` events for the same `(runId, hookId)`.
 *
 * The marker is written via `writeExclusive` — the first retry to
 * land it pins its candidate eventId as canonical, and every
 * subsequent retry reads and adopts that eventId before the common
 * event publish. Schema is just `{ eventId }` because identity is
 * already encoded in the marker's filename hash, so different token
 * lifetimes can never share one marker (see
 * `hookRecoveryMarkerPath`).
 */
const HookRecoveryMarkerSchema = z.object({
  eventId: z.string(),
});

/**
 * Durable `(runId, resumeId)` claim for a lazy hook resume. Written via
 * `writeExclusive` at {@link hookResumeClaimPath} BEFORE the `hook_received`
 * event is appended, so the two parallel-path writers (the producer's direct
 * write and the queue consumer's re-ensure) converge on the one canonical
 * `eventId` pinned here instead of appending two events. `payloadDigest`
 * records the content hash so a reused `resumeId` carrying a different payload
 * can be rejected as a conflict, matching the server's constraint.
 */
const HookResumeClaimSchema = z.object({
  runId: z.string(),
  resumeId: z.string(),
  hookId: z.string(),
  eventId: z.string(),
  payloadDigest: z.string().optional(),
});

/**
 * Whether `event` is the `hook_received` a resume claim stands for.
 *
 * The claim names the id its writer INTENDED to publish at, drawn from that
 * writer's slot allocator before the append. Under slot ids that intent is not
 * a reservation: the allocator is per storage instance, so an instance sharing
 * the directory can publish an unrelated event at the same position first, and
 * the resume then lands somewhere else. An event read back at the claimed id
 * therefore has to be identified, not assumed — returning whatever occupies the
 * position reports a `run_started` as the resume's own event and silently drops
 * the payload.
 */
function isResumeEvent(
  event: Event,
  claim: z.infer<typeof HookResumeClaimSchema>
): boolean {
  return (
    event.eventType === 'hook_received' &&
    event.correlationId === claim.hookId &&
    // `resumeId` is persisted on every hook_received written through the
    // resume path; an event without one predates that and can only be matched
    // by position.
    (event.resumeId === undefined || event.resumeId === claim.resumeId)
  );
}

/**
 * Finds the event a resume already committed, by the `resumeId` persisted on
 * the event itself rather than by the position the claim guessed.
 *
 * This is the authority the claim's `eventId` only approximates. Reached when
 * the claimed position holds nothing (a crash between claim and append) or
 * holds an unrelated event (a cross-instance slot collision), so it pays its
 * O(run's events) reads on rare paths only.
 */
async function findCommittedResumeEvent(
  basedir: string,
  runId: string,
  claim: z.infer<typeof HookResumeClaimSchema>,
  tag?: string
): Promise<Event | null> {
  const scan = await scanRunEventIds(basedir, runId, tag);
  for (const eventId of scan.ids) {
    const event = await readJSONWithFallback(
      basedir,
      'events',
      `${runId}-${eventId}`,
      EventSchema,
      tag
    );
    if (
      event &&
      event.resumeId === claim.resumeId &&
      isResumeEvent(event, claim)
    ) {
      return event;
    }
  }
  return null;
}
/**
 * Whether a token claim held by another `(runId, hookId)` can never become
 * live again and may therefore be released by a new claimant:
 *
 *   - the claimed hook's disposal is committed (its dispose lock exists —
 *     the durable release of the claim file just hasn't landed yet, or was
 *     lost to a crash between the lock write and the claim delete), or
 *   - the owning run is terminal and its minimum retention has ended, or
 *   - the owning run does not exist (a claim can only be written during a
 *     suspension of an existing run, so an ownerless claim is debris).
 *
 * A claim from a mid-creation writer is never releasable: its owning run
 * exists and is non-terminal, and its dispose lock does not exist.
 */
async function isHookTokenClaimReleasable(
  basedir: string,
  claim: HookTokenClaim,
  tag?: string
): Promise<boolean> {
  if (
    claim.hookId &&
    (await isHookDisposalCommitted(basedir, claim.hookId, tag))
  ) {
    return true;
  }
  const owningRun = await readJSONWithFallback(
    basedir,
    'runs',
    claim.runId,
    WorkflowRunSchema,
    tag
  );
  if (!owningRun) {
    return true;
  }
  if (!isTerminalWorkflowRunStatus(owningRun.status)) {
    return false;
  }
  return (
    !claim.tokenRetentionUntil ||
    claim.tokenRetentionUntil.getTime() <= Date.now()
  );
}

async function readHookRecoveryMarker(
  markerPath: string
): Promise<z.infer<typeof HookRecoveryMarkerSchema> | null> {
  try {
    return await readJSON(markerPath, HookRecoveryMarkerSchema);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

/**
 * Probe the run's event log for an existing `hook_created` event
 * with the given correlationId. Used by the legacy-claim recovery
 * path to detect "already published by a pre-upgrade write" before
 * pinning a canonical eventId — without this check, a post-upgrade
 * retry encountering a legacy claim whose `hook_created` was
 * already written (with the pre-upgrade writer's own eventId) would
 * pin a *different* eventId via the marker and publish a duplicate
 * event at the marker's path.
 *
 * The inline-`eventId` fast path does NOT need this probe: the
 * canonical eventId is durable in the claim file, so the existing
 * publish (`writeExclusive(eventPath)`) will fail iff the event
 * already exists at that exact path — which is the correct
 * "already-published" semantic.
 */
/**
 * Log order for a slot-numbered run is slot order, not `createdAt` order. A
 * writer stamps `createdAt` when it enters `create()` but only claims its slot
 * at publish time, so a writer that loses a slot race and bumps ends up with a
 * higher slot and an older timestamp than the writer that beat it. Slot order
 * is the one both writers agree on, and it is what makes the log dense and
 * position-addressable, so it wins.
 *
 * Returns `null` for a ULID-numbered run, which falls back to
 * `(createdAt, eventId)` — the two never mix within one run.
 */
function eventSortKey(event: Event): string | null {
  return isSlotEventId(event.eventId) ? event.eventId : null;
}

async function findExistingHookCreatedEventId(
  basedir: string,
  runId: string,
  correlationId: string
): Promise<string | null> {
  const result = await paginatedFileSystemQuery({
    directory: path.join(basedir, 'events'),
    schema: EventSchema,
    filePrefix: `${runId}-`,
    filter: (event) =>
      event.eventType === 'hook_created' &&
      event.correlationId === correlationId,
    limit: 1,
    getCreatedAt: getObjectCreatedAt('evnt'),
    getId: (event) => event.eventId,
  });
  return result.data[0]?.eventId ?? null;
}

/**
 * Repair an "event-first orphan": the hook entity write is deferred
 * until after the `hook_created` event publish commits (so a failed
 * publish cannot mutate already-committed state — see the comment on
 * the deferred write), which opens the inverse crash window — a
 * crash AFTER the event publish but BEFORE the deferred entity write
 * leaves the event in the log with the hook entity missing. A retry
 * then collides at the event publish and throws
 * `EntityConflictError` (correct — the event IS committed), but
 * without this repair the entity would stay missing forever and the
 * hook would be unresolvable.
 *
 * The entity MUST be reconstructed from the persisted canonical
 * event's payload — NOT the retry's `eventData` — otherwise a retry
 * carrying different `metadata` / `isWebhook` would silently change
 * committed state. The write uses `writeExclusive` (create-if-absent)
 * so a concurrent writer racing this repair cannot be overwritten;
 * whichever write lands first, the content is identical because both
 * derive from the same persisted event.
 */
async function repairHookEntityFromPersistedEvent(
  basedir: string,
  runId: string,
  hookId: string,
  persistedEventId: string,
  tag: string | undefined
): Promise<void> {
  const compositeKey = `${runId}-${persistedEventId}`;
  const persistedEvent = await readJSONWithFallback(
    basedir,
    'events',
    compositeKey,
    EventSchema,
    tag
  );
  if (
    !persistedEvent ||
    persistedEvent.eventType !== 'hook_created' ||
    persistedEvent.correlationId !== hookId
  ) {
    // Nothing trustworthy to repair from.
    return;
  }
  const existingHook = await readJSONWithFallback(
    basedir,
    'hooks',
    hookId,
    HookSchema,
    tag
  );
  if (existingHook) {
    // Entity already present — not an orphan, leave it untouched.
    return;
  }
  const hook = hookFromCreatedEvent(persistedEvent);
  // This path can repair events published by pre-index writers, so
  // (idempotently) index the persisted event before the entity write.
  await writeHookCreatedIndexEntries(
    basedir,
    hook.token,
    runId,
    hookId,
    persistedEventId,
    tag
  );
  await writeHookByRunMarker(basedir, runId, hookId, tag);
  await writeExclusive(
    taggedPath(basedir, 'hooks', hookId, tag),
    JSON.stringify(hook, jsonReplacer, 2)
  );
}

/**
 * Atomically pin a canonical `hook_created` eventId for a legacy
 * claim (one without an inline `eventId`). The first retry to
 * `writeExclusive` the recovery marker wins; its `candidateEventId`
 * becomes canonical. Subsequent retries read the marker and adopt
 * its `eventId`. Together with the `writeExclusive(eventPath)` in
 * the outer event publish, this gives the legacy-fallback path the
 * same single-event convergence guarantee as the inline-`eventId`
 * fast path.
 *
 * Returns the canonical eventId for the caller to adopt, or `null`
 * if we lost the marker race AND the resulting marker file is
 * unreadable (extremely rare; corrupted disk). Callers treat `null`
 * as "give up, throw `EntityConflictError`" so the runtime's
 * concurrent-replay catch path swallows this attempt and lets
 * another one through.
 */
async function pinCanonicalEventIdForLegacyClaim(
  basedir: string,
  token: string,
  runId: string,
  hookId: string,
  candidateEventId: string
): Promise<string | null> {
  const markerPath = hookRecoveryMarkerPath(basedir, token, runId, hookId);
  const markerContent = JSON.stringify({ eventId: candidateEventId });
  const won = await writeExclusive(markerPath, markerContent);
  if (won) {
    return candidateEventId;
  }
  const existing = await readHookRecoveryMarker(markerPath);
  return existing?.eventId ?? null;
}

/**
 * In-process per-key async mutex backed by a caller-supplied `Map`.
 * Used by `createEventsStorage` to serialize same-key event writes
 * (`step_*` for the same step, `hook_created` for the same hook).
 * The map is instantiated per-storage-instance — different
 * instances do NOT share locks, so two instances sharing one data
 * directory behave exactly like two separate OS processes from the
 * locking standpoint. Cross-instance / cross-process arbitration
 * relies on the on-disk constraint / claim files instead.
 */
function withInProcessLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = locks.get(key);
  const taskBox: { task?: Promise<T> } = {};
  const task = (async () => {
    if (prev) {
      // Wait for the previous task to settle; don't inherit its errors.
      await prev.catch(() => undefined);
    }
    try {
      return await fn();
    } finally {
      if (locks.get(key) === taskBox.task) {
        locks.delete(key);
      }
    }
  })();
  taskBox.task = task;
  locks.set(key, task);
  return task;
}

/**
 * Helper function to delete all waits associated with a workflow run.
 * Called when a run reaches a terminal state.
 */
async function deleteAllWaitsForRun(
  basedir: string,
  runId: string
): Promise<void> {
  const waitsDir = path.join(basedir, 'waits');
  const files = await listJSONFiles(waitsDir);

  for (const file of files) {
    // fileIds may contain tag suffixes (e.g., "wrun_ABC-corrId.vitest-0")
    // but startsWith still matches correctly since the tag is a suffix.
    if (file.startsWith(`${runId}-`)) {
      const waitPath = path.join(waitsDir, `${file}.json`);
      await deleteJSON(waitPath);
    }
  }
}

/**
 * Persist a lifecycle-driven run update (run_started / run_completed /
 * run_failed / run_cancelled) under the shared per-run file lock,
 * re-reading the on-disk run inside the lock so any attribute writes
 * that landed between the pre-validation `currentRun` read and this
 * write are preserved. Without the re-read, an `experimentalSetAttributes`
 * call sandwiched between the lifecycle read and write would be
 * silently overwritten by the lifecycle write's stale attribute snapshot.
 *
 * `proposed` is the fully-constructed run row the caller wants to
 * write (with the correct discriminated-union status branch). Only the
 * `attributes` field is replaced with the freshest version inside the
 * lock.
 */
async function writeRunUnderLifecycleLock<T extends WorkflowRun>(
  basedir: string,
  runId: string,
  tag: string | undefined,
  proposed: T
): Promise<T> {
  return withRunFileLock(runId, async () => {
    const fresh = await readJSON(
      taggedPath(basedir, 'runs', runId, tag),
      WorkflowRunSchema
    );
    const next: T = {
      ...proposed,
      attributes: fresh?.attributes ?? proposed.attributes,
    };
    await writeJSON(taggedPath(basedir, 'runs', runId, tag), next, {
      overwrite: true,
    });
    return next;
  });
}

/**
 * Creates the events storage implementation using the filesystem.
 * Implements the Storage['events'] interface with create, list, and listByCorrelationId operations.
 */
export type LocalEventsStorage = Storage['events'] & {
  clearCache(): void;
};

export function createEventsStorage(
  basedir: string,
  tag?: string
): LocalEventsStorage {
  const hookRetentionLimitMs = getHookRetentionLimitMs();
  // Events are append-only. Keep a bounded window of locally persisted events
  // available to immediate replay without rereading JSON files. Payload bytes
  // and entry count are both bounded so active/waiting runs cannot retain
  // unbounded histories in a long-lived development server.
  const maxCachedEventBytes = 4 * 1024 * 1024;
  const maxCachedEventEntries = 1000;
  const eventCache = new Map<string, Event>();
  const cachedEventBytes = new Map<string, number>();
  const cachedPathsByRunId = new Map<string, Set<string>>();
  let totalCachedEventBytes = 0;

  function deleteCachedEvent(eventPath: string): void {
    const event = eventCache.get(eventPath);
    if (!event) {
      return;
    }
    eventCache.delete(eventPath);
    totalCachedEventBytes -= cachedEventBytes.get(eventPath) ?? 0;
    cachedEventBytes.delete(eventPath);
    const cachedPaths = cachedPathsByRunId.get(event.runId);
    cachedPaths?.delete(eventPath);
    if (cachedPaths?.size === 0) {
      cachedPathsByRunId.delete(event.runId);
    }
  }

  function clearRunCache(runId: string): void {
    for (const cachedPath of cachedPathsByRunId.get(runId) ?? []) {
      deleteCachedEvent(cachedPath);
    }
  }

  function clearCache(): void {
    eventCache.clear();
    cachedEventBytes.clear();
    cachedPathsByRunId.clear();
    totalCachedEventBytes = 0;
    runSlotState.clear();
  }

  // ------------------------------------------------------------------
  // Slot allocation
  // ------------------------------------------------------------------
  //
  // Event ids are per-run positions (`evnt_` + a 26-char zero-padded
  // decimal), dense and 1-based, so the count of a run's events and the
  // highest id are the same number. That equivalence is what lets a writer
  // state its position with a single integer, and it only holds if the World
  // never leaves a hole: a slot is claimed by the publish that occupies it,
  // never reserved ahead of a write that might still be rejected.
  //
  // Runs created before slot ids keep their ULIDs for life. A log may not mix
  // the two schemes (`events.list` sorts on the id, and they do not
  // interleave), so the ids already on disk are the authoritative pin — no
  // spec-version negotiation is involved. `null` state below means "this run
  // is ULID-numbered".
  //
  // The cache is per storage instance. Two instances sharing one directory
  // (a test-only configuration this backend supports) can both believe they
  // own the same slot; the exclusive publish arbitrates, and the loser
  // rescans and bumps.
  const runSlotState = new Map<string, { next: number } | null>();

  function slotStateKey(runId: string): string {
    return tag ? `${runId}.${tag}` : runId;
  }

  /**
   * Draws the next candidate slot for `runId`, or null when the run is
   * ULID-numbered and should keep minting ULIDs.
   *
   * `atLeast` re-floors the counter after a lost publish. `held` names a slot
   * the caller already drew and is still holding: when the rescan shows it is
   * unclaimed and undominated, it is handed back instead of a fresh one, so a
   * redraw does not leave a hole. The directory scan runs once per run per
   * instance (and again on a `rescan`), not once per write.
   */
  async function drawEventSlot(
    runId: string,
    opts?: { rescan?: boolean; atLeast?: number; held?: number }
  ): Promise<number | null> {
    const key = slotStateKey(runId);
    let state = runSlotState.get(key);
    let scan: RunEventIdScan | null = null;
    if (state === undefined || opts?.rescan) {
      scan = await scanRunEventIds(basedir, runId, tag);
      if (state === undefined) {
        // A run with no events yet is brand new: it starts on slots. A run
        // whose visible events are ULIDs stays on ULIDs for life.
        state =
          scan.count > 0 && !scan.usesSlots
            ? null
            : { next: Math.max(scan.maxSlot + 1, FIRST_EVENT_SLOT) };
        runSlotState.set(key, state);
      } else if (state !== null) {
        // A rescan only ever moves the counter forward. Slots drawn but not
        // yet published are invisible to the scan, and handing one out twice
        // would make two in-flight writers of this instance collide.
        state.next = Math.max(state.next, scan.maxSlot + 1);
      }
    }
    if (state === null) {
      return null;
    }
    if (
      opts?.held !== undefined &&
      state.next === opts.held + 1 &&
      (scan?.maxSlot ?? 0) < opts.held
    ) {
      // No other draw from this instance and no publish from any other has
      // reached the held slot, so it still dominates the log.
      return opts.held;
    }
    if (opts?.atLeast !== undefined && state.next < opts.atLeast) {
      state.next = opts.atLeast;
    }
    const slot = state.next;
    state.next = slot + 1;
    return slot;
  }

  /** Mints the next event id for `runId` under whichever scheme it uses. */
  async function mintEventId(runId: string): Promise<string> {
    const slot = await drawEventSlot(runId);
    return slot === null ? `evnt_${monotonicUlid()}` : slotToEventId(slot);
  }

  /**
   * Mints the key a terminal transition appends under, re-derived at its
   * linearization point (after the marker + reap) so it sorts after any
   * `hook_received` that legitimately won the promote arbitration.
   *
   * For slot runs the rescan is the whole mechanism: it floors the counter
   * past anything another instance promoted while this invocation was
   * stalled, and the drawn slot dominates by construction. `heldEventId` is
   * the id already drawn for this write, kept when the rescan shows nothing
   * overtook it so the uncontended case leaves no hole.
   */
  async function mintDominantEventKey(
    runId: string,
    heldEventId: string
  ): Promise<{ eventId: string; createdAt: Date }> {
    const slot = await drawEventSlot(runId, {
      rescan: true,
      held: eventIdToSlot(heldEventId) ?? undefined,
    });
    if (slot !== null) {
      return { eventId: slotToEventId(slot), createdAt: new Date() };
    }
    return mintRunDominantEventKey(basedir, runId, tag);
  }

  function cacheEvent(
    eventPath: string,
    cachedEvent: Event,
    serializedBytes: number
  ): void {
    if (serializedBytes > maxCachedEventBytes) {
      return;
    }

    while (
      eventCache.size > 0 &&
      (eventCache.size >= maxCachedEventEntries ||
        totalCachedEventBytes + serializedBytes > maxCachedEventBytes)
    ) {
      const oldestPath = eventCache.keys().next().value as string;
      deleteCachedEvent(oldestPath);
    }

    eventCache.set(eventPath, cachedEvent);
    cachedEventBytes.set(eventPath, serializedBytes);
    totalCachedEventBytes += serializedBytes;
    const cachedPaths =
      cachedPathsByRunId.get(cachedEvent.runId) ?? new Set<string>();
    cachedPaths.add(eventPath);
    cachedPathsByRunId.set(cachedEvent.runId, cachedPaths);
  }

  // Update the in-memory cache for an event that was just persisted at
  // `eventPath`. `serializedEvent` must be the exact byte payload written
  // to disk: decoding it (instead of the caller's `event`) both detaches
  // caller-owned payloads and matches disk-read normalization. Callers
  // must capture `serializedEvent` *before* the write's `await` so the
  // cached snapshot can never observe a later mutation.
  function rememberStoredEvent(
    event: Event,
    eventPath: string,
    serializedEvent: string
  ): void {
    // Terminal runs release their cached history so a long-lived dev
    // server doesn't retain completed runs forever.
    if (isTerminalRunEventType(event.eventType)) {
      clearRunCache(event.runId);
      return;
    }

    const serializedBytes = Buffer.byteLength(serializedEvent);
    if (serializedBytes > maxCachedEventBytes) {
      return;
    }

    const cachedEvent = EventSchema.safeParse(
      JSON.parse(serializedEvent, jsonReviver)
    );
    if (cachedEvent.success) {
      cacheEvent(eventPath, cachedEvent.data, serializedBytes);
    }
  }

  async function storeEvent(event: Event): Promise<void> {
    const eventPath = taggedPath(
      basedir,
      'events',
      `${event.runId}-${event.eventId}`,
      tag
    );
    const serializedEvent = JSON.stringify(event, jsonReplacer, 2);
    await write(eventPath, serializedEvent);
    rememberStoredEvent(event, eventPath, serializedEvent);
  }

  // Per-instance in-process mutexes. Two storage instances sharing
  // one data directory get independent lock maps, which makes them
  // behave like two separate OS processes from the locking
  // standpoint — cross-instance arbitration relies on the on-disk
  // `writeExclusive` constraint / claim files instead. Tests use
  // this to exercise cross-process convergence without spawning
  // subprocesses.
  //
  // `stepLocks` serializes step lifecycle events for the same
  // (runId, correlationId): see comment further down in the
  // `isStepEvent` branch.
  //
  // `hookLocks` serializes `hook_created` calls for the same
  // (runId, correlationId) so the "claim token, then write hook
  // entity + event" sequence runs to completion before another
  // in-process invocation enters the dedup branch.
  const stepLocks = new Map<string, Promise<unknown>>();
  const hookLocks = new Map<string, Promise<unknown>>();

  const storage: LocalEventsStorage = {
    clearCache,
    async create(runId, data, params): Promise<EventResult> {
      if (
        data.eventType === 'hook_created' &&
        data.eventData.tokenRetentionUntil !== undefined &&
        data.eventData.tokenRetentionUntil.getTime() >
          Date.now() + hookRetentionLimitMs
      ) {
        throw new WorkflowWorldError(
          `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Local World.`,
          { status: 400 }
        );
      }

      // Validate request-supplied IDs before they're concatenated into
      // filesystem paths. This is the primary defense against path traversal
      // attacks where a client supplies runId / correlationId values like
      // "../../../package" to read or write files outside the storage root.
      // Run before taking the per-step mutex so malformed inputs fail fast.
      //
      // Empty `correlationId` values are also rejected here: the event
      // schemas only require `z.string()`, so without this check a
      // step_created / hook_created / wait_created request with
      // `correlationId: ''` would silently be written under a malformed
      // composite key like `${runId}-`.
      if (runId != null && runId !== '') {
        assertSafeEntityId('runId', runId);
      }
      if ('correlationId' in data && typeof data.correlationId === 'string') {
        assertSafeEntityId('correlationId', data.correlationId);
      }

      // Step lifecycle events are serialized per-step via an in-process mutex
      // so that the "check state, then write" sequence in step_started /
      // step_completed / step_failed / step_retrying is atomic. step_created
      // is also serialized so duplicate-create races don't leave extra
      // step_created events in the log.
      if (isStepEventType(data.eventType) && runId && data.correlationId) {
        const lockKey = tag
          ? `${runId}-${data.correlationId}.${tag}`
          : `${runId}-${data.correlationId}`;
        return withInProcessLock(stepLocks, lockKey, () => createImpl());
      }
      // `hook_created` is serialized per-(runId, hookId) so the
      // "claim token, write hook entity, write event" sequence runs to
      // completion before another in-process invocation enters the
      // same-hook dedup branch. Without this, two same-tick concurrent
      // callers can race between the winner's `writeExclusive(claim)`
      // and `writeJSON(hook)`, making the second caller momentarily
      // observe a claim with no matching hook entity — which the
      // crash-recovery path below would misinterpret as a prior crash
      // and incorrectly fall through to a second hook entity write.
      // `hook_received` and `hook_disposed` share the same per-hook lock
      // so a resume's "hook exists and is not disposed, then append"
      // sequence is atomic with respect to the disposer's "write dispose
      // lock, delete entity, then append" sequence. Without this, a
      // resume that passed its existence check before the disposal began
      // could append its `hook_received` AFTER `hook_disposed` — an
      // ordering that is journaled durably and makes every subsequent
      // replay of the owning run diverge at that event
      // (https://github.com/vercel/workflow/issues/2781).
      if (
        isHookLifecycleEventType(data.eventType) &&
        runId &&
        data.correlationId
      ) {
        const lockKey = tag
          ? `${runId}-${data.correlationId}.hook.${tag}`
          : `${runId}-${data.correlationId}.hook`;
        return withInProcessLock(hookLocks, lockKey, createImpl);
      }
      return createImpl();

      async function createImpl(): Promise<EventResult> {
        // Most paths use the freshly-drawn candidate eventId. The
        // hook_created dedup-recovery path below may reassign it to
        // the canonical eventId persisted in the durable token claim
        // so concurrent / cross-process workers converge on a single
        // event in the log; `eventIdPinned` records that, because a pinned
        // id must never be bumped past a slot collision (bumping would
        // defeat the convergence and duplicate the event).
        //
        // Drawn below rather than here: slots are positions, so they must be
        // drawn in publish order. The resilient-start path writes a synthetic
        // `run_created` that has to precede this event in the log, and a slot
        // drawn at function entry would sort after it.
        let eventId = '';
        let eventIdPinned = false;
        // The eventId currently recorded in this resume's `(runId, resumeId)`
        // claim, when one was written or read below. An unpinned publish is
        // free to land somewhere else, and the claim is the fast path other
        // writers read first, so it is corrected once the append commits.
        let resumeClaimRecordedId: string | null = null;
        const now = new Date();

        // For run_created events, use client-provided runId or generate one server-side
        let effectiveRunId: string;
        if (data.eventType === 'run_created' && (!runId || runId === '')) {
          effectiveRunId = `wrun_${monotonicUlid()}`;
        } else if (!runId) {
          throw new Error('runId is required for non-run_created events');
        } else {
          effectiveRunId = runId;
        }

        // Validate client-provided runId timestamp is within acceptable threshold
        if (data.eventType === 'run_created' && runId && runId !== '') {
          const validationError = validateUlidTimestamp(
            effectiveRunId,
            'wrun_'
          );
          if (validationError) {
            throw new WorkflowWorldError(validationError);
          }
        }

        // specVersion is always sent by the runtime, but we provide a fallback for safety
        const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

        // Get current run state for validation (if not creating a new run)
        // Skip run validation for step_completed and step_retrying - they only operate
        // on running steps, and running steps are always allowed to modify regardless
        // of run state. This optimization saves filesystem reads per step event.
        let currentRun: WorkflowRun | null = null;
        const skipRunValidationEvents = ['step_completed', 'step_retrying'];
        if (
          data.eventType !== 'run_created' &&
          !skipRunValidationEvents.includes(data.eventType)
        ) {
          currentRun = await readJSONWithFallback(
            basedir,
            'runs',
            effectiveRunId,
            WorkflowRunSchema,
            tag
          );

          // Resilient start: run_started on non-existent run with eventData
          // creates the run first, so the queue can bootstrap a run that
          // failed to create during start().
          if (
            data.eventType === 'run_started' &&
            !currentRun &&
            'eventData' in data &&
            data.eventData
          ) {
            const runInputData = data.eventData as {
              deploymentId?: string;
              workflowName?: string;
              input?: any;
              executionContext?: Record<string, any>;
              attributes?: Record<string, string>;
              allowReservedAttributes?: true;
              encryptionPublicKey?: string;
            };
            if (
              runInputData.deploymentId &&
              runInputData.workflowName &&
              runInputData.input !== undefined
            ) {
              validateAttributeChanges(
                Object.entries(runInputData.attributes ?? {}).map(
                  ([key, value]) => ({ key, value })
                ),
                {
                  allowReservedAttributes:
                    runInputData.allowReservedAttributes === true,
                }
              );
              // Atomically try to publish the run entity so only the first
              // writer wins, preventing a TOCTOU race where a concurrent
              // run_created from start() could overwrite a run that was
              // already transitioned to 'running'.
              const createdRun: WorkflowRun = {
                runId: effectiveRunId,
                deploymentId: runInputData.deploymentId,
                status: 'pending',
                workflowName: runInputData.workflowName,
                specVersion: effectiveSpecVersion,
                executionContext: runInputData.executionContext,
                input: runInputData.input,
                output: undefined,
                error: undefined,
                startedAt: undefined,
                completedAt: undefined,
                attributes: runInputData.attributes ?? {},
                // Must be mirrored here too: this is the path that recreates a
                // run from the queued message, which is exactly when the key
                // would otherwise be lost for the rest of the run's life.
                encryptionPublicKey: runInputData.encryptionPublicKey,
                createdAt: now,
                updatedAt: now,
              };
              const runPath = taggedPath(basedir, 'runs', effectiveRunId, tag);
              const created = await writeExclusive(
                runPath,
                JSON.stringify(createdRun, jsonReplacer)
              );

              if (created) {
                // We created the run — also write the run_created event.
                // Drawn before this invocation's own id so it takes the
                // earlier slot: it must replay first.
                const runCreatedEventId = await mintEventId(effectiveRunId);
                const runCreatedEvent: Event = {
                  eventType: 'run_created',
                  runId: effectiveRunId,
                  eventId: runCreatedEventId,
                  createdAt: now,
                  specVersion: effectiveSpecVersion,
                  eventData: {
                    deploymentId: runInputData.deploymentId,
                    workflowName: runInputData.workflowName,
                    input: runInputData.input,
                    executionContext: runInputData.executionContext,
                    attributes: runInputData.attributes,
                    allowReservedAttributes:
                      runInputData.allowReservedAttributes,
                    encryptionPublicKey: runInputData.encryptionPublicKey,
                  },
                };
                await storeEvent(runCreatedEvent);
                currentRun = createdRun;
              } else {
                // Run already exists (concurrent run_created won the
                // race). Re-read it so downstream logic sees the real state.
                currentRun = await readJSONWithFallback(
                  basedir,
                  'runs',
                  effectiveRunId,
                  WorkflowRunSchema,
                  tag
                );
              }
            }
          }
        }

        // Draw this event's id now that any synthetic `run_created` above has
        // taken the earlier slot. Every path below either publishes at this
        // id or replaces it with one pinned by a durable claim.
        eventId = await mintEventId(effectiveRunId);

        // run_failed on a non-existent run is rejected to match the
        // postgres and vercel worlds, which both surface this as a
        // WorkflowRunNotFoundError rather than silently persisting an
        // event for a run that was never created.
        if (data.eventType === 'run_failed' && !currentRun) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        if (data.eventType === 'attr_set' && !currentRun) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }

        // ============================================================
        // VERSION COMPATIBILITY: Check run spec version
        // ============================================================
        // For events that have fetched the run, check version compatibility.
        // Skip for run_created (no existing run) and runtime events (step_completed, step_retrying).
        if (currentRun) {
          // Check if run requires a newer world version
          if (requiresNewerWorld(currentRun.specVersion)) {
            throw new RunNotSupportedError(
              currentRun.specVersion!,
              SPEC_VERSION_CURRENT
            );
          }

          // Route to legacy handler for pre-event-sourcing runs
          if (isLegacySpecVersion(currentRun.specVersion)) {
            return handleLegacyEvent(
              basedir,
              effectiveRunId,
              data,
              currentRun,
              params
            );
          }
        }

        // ============================================================
        // VALIDATION: Terminal state and event ordering checks
        // ============================================================

        // Lazy step start: a step_started carrying step-creation data
        // (stepName + input) is allowed to arrive with no prior step_created
        // — it creates the step on the fly (see the materialization block
        // below). This mirrors the resilient run_started path. Detect it here
        // so the entity-creation terminal-run guard treats it like a creation
        // and the "step must exist" ordering guard doesn't reject it.
        const createsChildEntity = isChildEntityCreationEvent(data);
        const lazyStepStart =
          createsChildEntity && data.eventType === 'step_started';

        // Run terminal state validation
        if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
          // Idempotent operation: run_cancelled on already cancelled run is allowed
          if (
            data.eventType === 'run_cancelled' &&
            currentRun.status === 'cancelled'
          ) {
            // Return existing state (idempotent)
            const event: Event = {
              ...data,
              runId: effectiveRunId,
              eventId,
              createdAt: now,
              specVersion: effectiveSpecVersion,
            };
            await storeEvent(event);
            const resolveData =
              params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            return {
              event: stripEventDataRefs(event, resolveData),
              run: currentRun,
              ...(currentRun ? { maxEvents: getMaxEventsPerRun() } : {}),
            };
          }

          // For run_started on terminal runs, use RunExpiredError so the
          // runtime knows to exit without retrying.
          if (data.eventType === 'run_started') {
            throw new RunExpiredError(
              `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`
            );
          }

          // Other run state transitions are not allowed on terminal runs
          if (isTerminalRunEventType(data.eventType)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${currentRun.status}"`
            );
          }

          // Creating new entities on terminal runs is not allowed. A lazy
          // step_started creates a step, so it is rejected here too — a bare
          // (non-lazy) step_started falls through to the step-validation
          // block below, which uses RunExpiredError for terminal runs.
          if (createsChildEntity) {
            throw new EntityConflictError(
              `Cannot create new entities on run in terminal state "${currentRun.status}"`
            );
          }

          if (data.eventType === 'attr_set') {
            throw new EntityConflictError(
              `Cannot set attributes on run in terminal state "${currentRun.status}"`
            );
          }
        }

        // Step-related event validation (ordering and terminal state)
        // Store existingStep so we can reuse it later (avoid double read)
        let validatedStep: Step | null = null;
        const stepEventRequiresExistingStep =
          isStepEventType(data.eventType) && data.eventType !== 'step_created';
        if (stepEventRequiresExistingStep && data.correlationId) {
          const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          validatedStep = await readJSONWithFallback(
            basedir,
            'steps',
            stepCompositeKey,
            StepSchema,
            tag
          );

          // Event ordering: step must exist before these events — except on
          // the lazy-start path, where step_started creates the step itself.
          if (!validatedStep && !lazyStepStart) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }

          // Lazy start exactly-once gate: a lazy step_started always CREATES
          // the step (the owned-inline path only sends one for a step whose
          // step_created it deferred). If the step already exists, a concurrent
          // handler won the create — this caller is a loser and must not start
          // or run the step. Throw EntityConflictError so the runtime's
          // executeStep maps it to `skipped`. This is critical: the plain start
          // transition below permits re-starting a non-terminal step (retries
          // rely on that), so without this gate a loser would re-start a
          // running step and run the body a second time.
          if (lazyStepStart && validatedStep) {
            throw new EntityConflictError(
              `Step "${data.correlationId}" already created`
            );
          }

          // Step terminal state validation. validatedStep can be null only on
          // the lazy-start path (no step yet) — there is nothing terminal to
          // guard against in that case, so these checks are skipped.
          if (validatedStep) {
            if (isTerminalStepStatus(validatedStep.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${validatedStep.status}"`
              );
            }

            // On terminal runs: only allow completing/failing in-progress steps
            if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
              if (validatedStep.status !== 'running') {
                throw new RunExpiredError(
                  `Cannot modify non-running step on run in terminal state "${currentRun.status}"`
                );
              }
            }
          }
        }

        // Hook-related event validation (ordering)
        if (
          isHookEventRequiringExistence(data.eventType) &&
          data.correlationId
        ) {
          // Redelivery convergence — checked BEFORE the disposal/existence
          // rejections below: if this resume's `(runId, resumeId)` claim is
          // already committed AND its pinned event is journaled, return that
          // event as success. The claim proves this exact resume was accepted
          // while the hook was alive, and the event is already in the log, so
          // replay observes it either way. Without this, a queue redelivery
          // of the consumer's re-ensure after the workflow disposed the hook
          // (dispose → sleep) is rejected with HookNotFound — which the
          // consumer treats as "nothing left to resume" and acks, losing
          // whatever continuation the message carried. A claim with a
          // mismatched hookId or payload digest is NOT converged here; it
          // falls through to the full validation below, which rejects it the
          // same way it always has.
          if (data.eventType === 'hook_received' && params?.resumeId) {
            const committedClaim = await readJSON(
              hookResumeClaimPath(basedir, effectiveRunId, params.resumeId),
              HookResumeClaimSchema
            );
            if (
              committedClaim &&
              committedClaim.hookId === data.correlationId &&
              (!params.resumePayloadDigest ||
                !committedClaim.payloadDigest ||
                committedClaim.payloadDigest === params.resumePayloadDigest)
            ) {
              const atClaimedId = await readJSONWithFallback(
                basedir,
                'events',
                `${effectiveRunId}-${committedClaim.eventId}`,
                EventSchema,
                tag
              );
              const committedEvent =
                atClaimedId && isResumeEvent(atClaimedId, committedClaim)
                  ? atClaimedId
                  : await findCommittedResumeEvent(
                      basedir,
                      effectiveRunId,
                      committedClaim,
                      tag
                    );
              if (committedEvent) {
                return { event: committedEvent };
              }
            }
          }
          // A resume must never be journaled after the hook's disposal.
          // The disposer's durable order is: dispose lock → claim/entity
          // delete → `hook_disposed` append, so the hook entity can still
          // exist (or the disposer may have crashed mid-teardown) while
          // disposal is already committed. Re-validate the dispose lock
          // here — under the per-hook in-process lock taken above — so
          // acceptance observes the same order replay will: once disposal
          // has committed, the resume is rejected exactly like one that
          // arrived after teardown finished.
          if (
            data.eventType === 'hook_received' &&
            (await isHookDisposalCommitted(basedir, data.correlationId, tag))
          ) {
            throw new HookNotFoundError(data.correlationId);
          }
          const existingHook = await readJSONWithFallback(
            basedir,
            'hooks',
            data.correlationId,
            HookSchema,
            tag
          );

          if (!existingHook) {
            throw new HookNotFoundError(data.correlationId);
          }

          // Lazy hook resume idempotency: the parallel fast path writes this
          // `hook_received` directly AND has the queue consumer re-ensure it,
          // both carrying the same `resumeId`, so both may reach here under the
          // per-hook lock. They must converge on ONE event. Keyed on
          // `(runId, resumeId)` — NOT on the hookId — because a reusable hook
          // receives many distinct resumes and each must record its own event;
          // only the two writers of a single resume collapse. The claim pins
          // the canonical eventId BEFORE the append so a cross-process writer
          // converges too. Gated on `resumeId` so the historical single-write
          // path is untouched.
          if (data.eventType === 'hook_received' && params?.resumeId) {
            const claimPath = hookResumeClaimPath(
              basedir,
              effectiveRunId,
              params.resumeId
            );
            const converge = async (
              claim: z.infer<typeof HookResumeClaimSchema>
            ): Promise<EventResult | null> => {
              // A resumeId reused across DIFFERENT hooks is a caller bug (or a
              // collision), not a benign redelivery of the same resume. Adopting
              // the first hook's event for a second hook would attribute a
              // resume to the wrong hook. The two writers of ONE resume always
              // carry the same hookId, so a mismatch can only mean the claim
              // belongs to another hook — reject, mirroring the server's
              // `(runId, resumeId)` constraint identity.
              if (claim.hookId !== data.correlationId) {
                throw new EntityConflictError(
                  `hook_received resumeId "${params.resumeId}" already recorded for a different hook`
                );
              }
              // A reused resumeId carrying a different payload is a caller bug,
              // not a benign redelivery — reject it exactly like the server's
              // constraint (which keys the digest into the claim).
              if (
                params.resumePayloadDigest &&
                claim.payloadDigest &&
                claim.payloadDigest !== params.resumePayloadDigest
              ) {
                throw new EntityConflictError(
                  `hook_received resumeId "${params.resumeId}" already recorded with a different payload`
                );
              }
              const atClaimedId = await readJSONWithFallback(
                basedir,
                'events',
                `${effectiveRunId}-${claim.eventId}`,
                EventSchema,
                tag
              );
              if (atClaimedId && isResumeEvent(atClaimedId, claim)) {
                return { event: atClaimedId };
              }
              // Either nothing is at the claimed position, or something that
              // is not this resume is. The claim's `eventId` is only where its
              // writer meant to append, so before concluding the resume is
              // uncommitted, look for it by the `resumeId` persisted on the
              // event.
              const committed = await findCommittedResumeEvent(
                basedir,
                effectiveRunId,
                claim,
                tag
              );
              if (committed) {
                return { event: committed };
              }
              // The resume really is uncommitted: a crash between the claim
              // write and the append. Take over the append. Adopt the claimed
              // position when it is still free — under ULIDs it always is, and
              // adopting keeps two takers writing the same path so one loses
              // the exclusive create instead of publishing a second event.
              // When an unrelated event holds it, there is nothing to converge
              // on: keep this writer's own id and let the publish bump.
              resumeClaimRecordedId = claim.eventId;
              if (!atClaimedId) {
                eventId = claim.eventId;
                eventIdPinned = true;
              }
              return null;
            };

            const existingClaim = await readJSON(
              claimPath,
              HookResumeClaimSchema
            );
            if (existingClaim) {
              const converged = await converge(existingClaim);
              if (converged) {
                return converged;
              }
            } else {
              // Reserve the claim (naming this candidate eventId) before the
              // append. If a concurrent/cross-process writer reserved it first,
              // converge on their event instead.
              //
              // Under ULIDs the candidate is pinned: the id is globally unique,
              // so the only writer that can collide with it is the other writer
              // of this same resume, and both must land on the one event.
              //
              // Under slot ids it cannot be. A slot is a position, not a name:
              // another instance's allocator hands out the same number for a
              // different event, and refusing to bump would fail this resume's
              // append outright. So the claimed id is a hint, the publish is
              // free to move, and `converge` identifies the resume's event by
              // its persisted `resumeId`. The claim is rewritten with the id
              // actually published once the append commits.
              eventIdPinned = !isSlotEventId(eventId);
              resumeClaimRecordedId = eventId;
              const won = await writeExclusive(
                claimPath,
                JSON.stringify({
                  runId: effectiveRunId,
                  resumeId: params.resumeId,
                  hookId: data.correlationId,
                  eventId,
                  ...(params.resumePayloadDigest
                    ? { payloadDigest: params.resumePayloadDigest }
                    : {}),
                } satisfies z.infer<typeof HookResumeClaimSchema>)
              );
              if (!won) {
                // Someone else's claim is the durable one now; this writer's
                // candidate is not what the claim records.
                resumeClaimRecordedId = null;
                const winner = await readJSON(claimPath, HookResumeClaimSchema);
                if (winner) {
                  const converged = await converge(winner);
                  if (converged) {
                    return converged;
                  }
                }
              }
            }
          }
        }
        // `event` may be reassigned later in the `hook_created`
        // dedup-recovery branch to swap in a canonical eventId /
        // createdAt persisted in the durable token claim so
        // concurrent / cross-process workers converge on a single
        // event in the log.
        let event: Event = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
          // Persist the lazy-resume idempotency key on the hook_received event
          // so the queue consumer can recognize the producer's concurrent
          // direct write already landed in its run_started preload and skip the
          // re-ensure. Gated on hook_received (params.resumeId is only set
          // there); mirrors the server's stored `resumeId` attribute. The
          // converge path above reads back this same persisted event, so both
          // writers of one resume return an event carrying the key.
          ...(data.eventType === 'hook_received' && params?.resumeId
            ? { resumeId: params.resumeId }
            : {}),
        };
        // Strip eventData from run_started — it belongs on run_created only.
        if (data.eventType === 'run_started' && 'eventData' in event) {
          delete (event as any).eventData;
        }
        // Strip only the step `input` from the lazy step_started event row —
        // it belongs on the synthetic step_created written above. stepName is
        // preserved for the client replay consumer's step-name divergence
        // check (packages/core/src/step.ts).
        if (
          lazyStepStart &&
          event.eventType === 'step_started' &&
          event.eventData
        ) {
          const { input: _strippedInput, ...eventData } = event.eventData;
          event = { ...event, eventData };
        }

        // Track entity created/updated for EventResult
        let run: WorkflowRun | undefined;
        let step: Step | undefined;
        let hook: Hook | undefined;
        let wait: Wait | undefined;
        // Lazy step start: set true when this step_started atomically created
        // the step (the caller won the create-claim). Surfaced on EventResult
        // as the runtime's exactly-once ownership signal.
        let stepCreatedLazily = false;
        // For `hook_created`, the hook entity write is deferred until
        // AFTER the outer event publish succeeds, so a retry that
        // collides with an already-published `hook_created` does not
        // mutate the durable hook entity with the retry's payload.
        // `hookEntityWriteOptions` carries the `{ overwrite }` mode
        // chosen by the dedup-recovery branch above (undefined for
        // first writers, `{ overwrite: true }` for retries that may
        // be repairing an orphaned partial write).
        let hookEntityWriteOptions: { overwrite: boolean } | undefined;

        // Terminal transitions commit in two cross-process-visible steps
        // BEFORE any terminal state write below (and thus before the
        // terminal event is appended to the log at the bottom of this
        // function):
        //
        //   1. Publish the durable run-terminal marker. Its existence is
        //      the earliest cross-process evidence that the run can never
        //      accept a new `hook_received` again — the run-level analogue
        //      of the hook dispose marker.
        //   2. Reap the run's staged (not yet reader-visible) hook_received
        //      events. A resume publishes in three steps — stage, re-check
        //      this marker, promote via atomic hard link into `events/` —
        //      so the reap's unlink and the resume's link race on the SAME
        //      staged file and the filesystem decides a single winner:
        //      either the resume's event was already visible before this
        //      transition proceeded (it legitimately precedes the
        //      termination), or its staged file is gone, its promotion
        //      fails, and the event is never visible to any reader. A
        //      resume that stages after this reap necessarily stages after
        //      the marker, and its own marker re-check rejects it. See
        //      `reapPendingHookEvents` for the full argument.
        //
        // The terminal-state validation above has already rejected
        // transitions from an already-terminal run, so reaching here means
        // this is a fresh terminal transition; `writeExclusive` returning
        // false (marker already present from a concurrent duplicate) is
        // harmless, and both duplicates reap.
        if (isTerminalRunEventType(data.eventType) && currentRun) {
          await writeExclusive(
            runTerminalMarkerPath(basedir, effectiveRunId, tag),
            ''
          );
          await reapPendingHookEvents(basedir, effectiveRunId, tag);
          // Re-derive this terminal event's replay-ordering key at the
          // linearization point. The eventId/createdAt allocated at
          // createImpl() entry can predate a hook_received that
          // legitimately won the promote arbitration while this invocation
          // was stalled before the marker write; events.list() sorts by
          // (createdAt, eventId), so the stale key would order the terminal
          // event BEFORE that accepted hook on replay. Every accepted hook
          // is reader-visible by the end of the reap, so a key that
          // strictly dominates all visible events of the run guarantees the
          // terminal event replays last. See mintRunDominantEventKey for
          // the dominance argument.
          const dominantKey = await mintDominantEventKey(
            effectiveRunId,
            eventId
          );
          eventId = dominantKey.eventId;
          event = { ...event, eventId, createdAt: dominantKey.createdAt };
        }

        // Create/update entity based on event type (event-sourced architecture)
        // Run lifecycle events
        if (data.eventType === 'run_created' && 'eventData' in data) {
          const runData = data.eventData as {
            deploymentId: string;
            workflowName: string;
            input: SerializedData;
            executionContext?: Record<string, any>;
            attributes?: Record<string, string>;
            allowReservedAttributes?: true;
            encryptionPublicKey?: string;
          };
          validateAttributeChanges(
            Object.entries(runData.attributes ?? {}).map(([key, value]) => ({
              key,
              value,
            })),
            {
              allowReservedAttributes: runData.allowReservedAttributes === true,
            }
          );
          run = {
            runId: effectiveRunId,
            deploymentId: runData.deploymentId,
            status: 'pending',
            workflowName: runData.workflowName,
            // Propagate specVersion from the event to the run entity
            specVersion: effectiveSpecVersion,
            executionContext: runData.executionContext,
            input: runData.input,
            output: undefined,
            error: undefined,
            startedAt: undefined,
            completedAt: undefined,
            attributes: runData.attributes ?? {},
            encryptionPublicKey: runData.encryptionPublicKey,
            createdAt: now,
            updatedAt: now,
          };
          // Atomically publish the run entity file without overwriting an
          // existing winner. This prevents a TOCTOU race with the resilient
          // start path (run_started on non-existent run) that could result in
          // duplicate run_created events in the event log.
          const runPath = taggedPath(basedir, 'runs', effectiveRunId, tag);
          const created = await writeExclusive(
            runPath,
            JSON.stringify(run, jsonReplacer, 2)
          );
          if (!created) {
            throw new EntityConflictError(
              `Workflow run "${effectiveRunId}" already exists`
            );
          }
        } else if (data.eventType === 'run_started') {
          // Reuse currentRun from validation (already read above)
          if (currentRun) {
            // If already running, return the run without inserting a
            // duplicate event.  This makes run_started idempotent for
            // concurrent invocations.  We omit preloaded events here
            // because this is a rare race-condition path — the runtime
            // falls back to loadWorkflowRunEvents().
            if (currentRun.status === 'running') {
              return { run: currentRun, maxEvents: getMaxEventsPerRun() };
            }

            run = await writeRunUnderLifecycleLock(
              basedir,
              effectiveRunId,
              tag,
              {
                runId: currentRun.runId,
                deploymentId: currentRun.deploymentId,
                workflowName: currentRun.workflowName,
                specVersion: currentRun.specVersion,
                executionContext: currentRun.executionContext,
                input: currentRun.input,
                createdAt: currentRun.createdAt,
                expiredAt: currentRun.expiredAt,
                status: 'running',
                output: undefined,
                error: undefined,
                completedAt: undefined,
                startedAt: currentRun.startedAt ?? now,
                updatedAt: now,
                attributes: currentRun.attributes,
                encryptionPublicKey: currentRun.encryptionPublicKey,
              }
            );
          }
        } else if (data.eventType === 'run_completed' && 'eventData' in data) {
          const completedData = data.eventData as { output?: any };
          // Reuse currentRun from validation (already read above)
          if (currentRun) {
            run = await writeRunUnderLifecycleLock(
              basedir,
              effectiveRunId,
              tag,
              {
                runId: currentRun.runId,
                deploymentId: currentRun.deploymentId,
                workflowName: currentRun.workflowName,
                specVersion: currentRun.specVersion,
                executionContext: currentRun.executionContext,
                input: currentRun.input,
                createdAt: currentRun.createdAt,
                expiredAt: currentRun.expiredAt,
                startedAt: currentRun.startedAt,
                status: 'completed',
                output: completedData.output,
                error: undefined,
                completedAt: now,
                updatedAt: now,
                attributes: currentRun.attributes,
                encryptionPublicKey: currentRun.encryptionPublicKey,
              }
            );
            await Promise.all([
              deleteAllHooksForRun(basedir, effectiveRunId),
              deleteAllWaitsForRun(basedir, effectiveRunId),
            ]);
          }
        } else if (data.eventType === 'run_failed' && 'eventData' in data) {
          const failedData = data.eventData as {
            error: unknown;
            errorCode?: string;
          };
          // Reuse currentRun from validation (already read above)
          if (currentRun) {
            // The error field is SerializedData (Uint8Array) produced by
            // dehydrateRunError. We store it verbatim — consumers hydrate it
            // via hydrateRunError to reconstruct the original thrown value.
            run = await writeRunUnderLifecycleLock(
              basedir,
              effectiveRunId,
              tag,
              {
                runId: currentRun.runId,
                deploymentId: currentRun.deploymentId,
                workflowName: currentRun.workflowName,
                specVersion: currentRun.specVersion,
                executionContext: currentRun.executionContext,
                input: currentRun.input,
                createdAt: currentRun.createdAt,
                expiredAt: currentRun.expiredAt,
                startedAt: currentRun.startedAt,
                status: 'failed',
                output: undefined,
                error: failedData.error as Uint8Array,
                errorCode: failedData.errorCode,
                completedAt: now,
                updatedAt: now,
                attributes: currentRun.attributes,
                encryptionPublicKey: currentRun.encryptionPublicKey,
              }
            );
            await Promise.all([
              deleteAllHooksForRun(basedir, effectiveRunId),
              deleteAllWaitsForRun(basedir, effectiveRunId),
            ]);
          }
        } else if (data.eventType === 'run_cancelled') {
          // Reuse currentRun from validation (already read above)
          if (currentRun) {
            run = await writeRunUnderLifecycleLock(
              basedir,
              effectiveRunId,
              tag,
              {
                runId: currentRun.runId,
                deploymentId: currentRun.deploymentId,
                workflowName: currentRun.workflowName,
                specVersion: currentRun.specVersion,
                executionContext: currentRun.executionContext,
                input: currentRun.input,
                createdAt: currentRun.createdAt,
                expiredAt: currentRun.expiredAt,
                startedAt: currentRun.startedAt,
                status: 'cancelled',
                output: undefined,
                error: undefined,
                completedAt: now,
                updatedAt: now,
                attributes: currentRun.attributes,
                encryptionPublicKey: currentRun.encryptionPublicKey,
              }
            );
            await Promise.all([
              deleteAllHooksForRun(basedir, effectiveRunId),
              deleteAllWaitsForRun(basedir, effectiveRunId),
            ]);
          }
        } else if (data.eventType === 'attr_set' && currentRun) {
          run = await withRunFileLock(effectiveRunId, async () => {
            const fresh = await readJSON(
              taggedPath(basedir, 'runs', effectiveRunId, tag),
              WorkflowRunSchema
            );
            if (!fresh) {
              throw new WorkflowRunNotFoundError(effectiveRunId);
            }
            validateAttributeChanges(data.eventData.changes, {
              existingKeys: Object.keys(fresh.attributes),
              allowReservedAttributes:
                data.eventData.allowReservedAttributes === true,
            });
            // Claim the correlation dedup lock only after validation: a
            // validation failure must leave the correlationId unclaimed so
            // the runtime's retry of the same event is not misreported as
            // "already exists" while the event was never written (the
            // dispatcher would then wait forever for an event that is not
            // in the log).
            if (
              data.correlationId &&
              data.eventData.writer.type === 'workflow'
            ) {
              const attrLockName = tag
                ? `${effectiveRunId}-${data.correlationId}.created.${tag}`
                : `${effectiveRunId}-${data.correlationId}.created`;
              const attrLockPath = resolveWithinBase(
                basedir,
                '.locks',
                'attributes',
                attrLockName
              );
              const attrClaimed = await writeExclusive(attrLockPath, '');
              if (!attrClaimed) {
                throw new EntityConflictError(
                  `Attribute event "${data.correlationId}" already exists`
                );
              }
            }
            const next = {
              ...fresh,
              attributes: applyAttributeChanges(
                fresh.attributes,
                data.eventData.changes
              ),
              updatedAt: now,
            } as WorkflowRun;
            await writeJSON(
              taggedPath(basedir, 'runs', effectiveRunId, tag),
              next,
              { overwrite: true }
            );
            return next;
          });
        } else if (
          // Step lifecycle events
          data.eventType === 'step_created' &&
          'eventData' in data
        ) {
          // step_created: Creates step entity with status 'pending', attempt=0, createdAt set.
          // Two concurrent invocations with identical correlationIds (e.g. the
          // snapshot runtime's deterministic correlationIds across replays)
          // must be deduped — otherwise both writes succeed and the event log
          // ends up with duplicate step_created entries. The outer
          // withStepLock mutex serializes within a single process; this
          // The exclusive constraint file additionally protects against
          // cross-process races (two pnpm workers, redelivered queue messages,
          // etc.). The loser throws EntityConflictError so the runtime's
          // existing catch path can swallow it and avoid double-queuing the
          // step.
          const stepCreatedLockName = tag
            ? `${effectiveRunId}-${data.correlationId}.created.${tag}`
            : `${effectiveRunId}-${data.correlationId}.created`;
          const stepCreatedLockPath = resolveWithinBase(
            basedir,
            '.locks',
            'steps',
            stepCreatedLockName
          );
          const stepCreatedClaimed = await writeExclusive(
            stepCreatedLockPath,
            ''
          );
          if (!stepCreatedClaimed) {
            throw new EntityConflictError(
              `Step "${data.correlationId}" already created`
            );
          }
          const stepData = data.eventData as {
            stepName: string;
            input: any;
          };
          step = {
            runId: effectiveRunId,
            stepId: data.correlationId,
            stepName: stepData.stepName,
            status: 'pending',
            input: stepData.input,
            output: undefined,
            error: undefined,
            attempt: 0,
            startedAt: undefined,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
            // Propagate specVersion from the event to the step entity
            specVersion: effectiveSpecVersion,
          };
          const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          await writeJSON(
            taggedPath(basedir, 'steps', stepCompositeKey, tag),
            step
          );
        } else if (data.eventType === 'step_started') {
          // step_started: Increments attempt, sets status to 'running'
          // Sets startedAt only on the first start (not updated on retries)
          // Reuse validatedStep from validation (already read above)

          // Lazy step start: no prior step_created — create the step entity
          // and a synthetic step_created event now, then fall through to the
          // start transition below. Mirrors the resilient run_started path:
          // the step entity is claimed atomically (first writer wins) and the
          // synthetic step_created event keeps replay correct (the client step
          // consumer marks hasCreatedEvent only when it observes that event).
          if (!validatedStep && lazyStepStart) {
            const lazyData = data.eventData;
            const stepCreatedLockName = tag
              ? `${effectiveRunId}-${data.correlationId}.created.${tag}`
              : `${effectiveRunId}-${data.correlationId}.created`;
            const stepCreatedLockPath = resolveWithinBase(
              basedir,
              '.locks',
              'steps',
              stepCreatedLockName
            );
            const stepCreatedClaimed = await writeExclusive(
              stepCreatedLockPath,
              ''
            );
            if (!stepCreatedClaimed) {
              // A concurrent handler already claimed the create for this
              // step. The atomic claim is the exactly-once ownership gate:
              // only the winner runs the step body inline. Throw
              // EntityConflictError — the runtime's executeStep maps this to
              // `skipped`, so the loser does not start or run the step. This
              // preserves the same "exactly one handler owns each step"
              // guarantee the separate step_created claim provides today.
              throw new EntityConflictError(
                `Step "${data.correlationId}" already created`
              );
            } else {
              const createdStep: Step = {
                runId: effectiveRunId,
                stepId: data.correlationId,
                stepName: lazyData.stepName,
                status: 'pending',
                input: lazyData.input,
                output: undefined,
                error: undefined,
                attempt: 0,
                startedAt: undefined,
                completedAt: undefined,
                createdAt: now,
                updatedAt: now,
                specVersion: effectiveSpecVersion,
              };
              await writeJSON(
                taggedPath(
                  basedir,
                  'steps',
                  `${effectiveRunId}-${data.correlationId}`,
                  tag
                ),
                createdStep
              );
              // Write the synthetic step_created event so replay observes it
              // (the client step consumer sets hasCreatedEvent only on a
              // step_created event). Its id comes from the run's own
              // allocator: minting a ULID here would put a second identity
              // scheme in a slot-numbered log, and `events.list` cannot
              // paginate a mixed log (a ULID id has no sort key, so it lands
              // on every page and the cursor eventually repeats).
              //
              // This slot is above the one already drawn for the step_started
              // event at the top of `create`, so the synthetic step_created
              // sorts after its own step_started. That is fine: step_started
              // is a parkable delivery, so a replay parks it until the
              // ordered step_created behind it registers the consumer, then
              // drains it.
              const stepCreatedEventId = await mintEventId(effectiveRunId);
              const stepCreatedEvent: Event = {
                eventType: 'step_created',
                runId: effectiveRunId,
                eventId: stepCreatedEventId,
                createdAt: now,
                specVersion: effectiveSpecVersion,
                correlationId: data.correlationId,
                eventData: {
                  stepName: lazyData.stepName,
                  input: lazyData.input,
                },
              };
              await storeEvent(stepCreatedEvent);
              validatedStep = createdStep;
              stepCreatedLazily = true;
            }
          }

          if (validatedStep) {
            // Check if retryAfter timestamp hasn't been reached yet
            if (
              validatedStep.retryAfter &&
              validatedStep.retryAfter.getTime() > Date.now()
            ) {
              throw new TooEarlyError(
                `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
                {
                  retryAfter: Math.ceil(
                    (validatedStep.retryAfter.getTime() - Date.now()) / 1000
                  ),
                }
              );
            }

            // Best-effort guard: re-read the step entity to check if it
            // reached terminal state between the validation read and now.
            // This narrows the TOCTOU window but does not fully eliminate it
            // (the local world is single-process / dev-only; the postgres
            // world uses SQL-level atomic guards for production).
            const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
            const freshStep = await readJSONWithFallback(
              basedir,
              'steps',
              stepCompositeKey,
              StepSchema,
              tag
            );
            if (freshStep && isTerminalStepStatus(freshStep.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${freshStep.status}"`
              );
            }

            step = {
              ...validatedStep,
              status: 'running',
              // Only set startedAt on the first start
              startedAt: validatedStep.startedAt ?? now,
              // Increment attempt counter on every start
              attempt: validatedStep.attempt + 1,
              // Clear retryAfter now that the step has started
              retryAfter: undefined,
              updatedAt: now,
            };
            await writeJSON(
              taggedPath(basedir, 'steps', stepCompositeKey, tag),
              step,
              { overwrite: true }
            );
          }
        } else if (data.eventType === 'step_completed' && 'eventData' in data) {
          // step_completed: Terminal state with output
          // Uses writeExclusive on a lock file to atomically prevent concurrent
          // invocations from both completing the same step (TOCTOU race).
          const completedData = data.eventData as { result: any };
          if (validatedStep) {
            const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
            const lockName = tag
              ? `${stepCompositeKey}.terminal.${tag}`
              : `${stepCompositeKey}.terminal`;
            const terminalLockPath = resolveWithinBase(
              basedir,
              '.locks',
              'steps',
              lockName
            );
            const claimed = await writeExclusive(terminalLockPath, '');
            if (!claimed) {
              throw new EntityConflictError(
                'Cannot modify step in terminal state'
              );
            }
            step = {
              ...validatedStep,
              status: 'completed',
              output: completedData.result,
              completedAt: now,
              updatedAt: now,
            };
            await writeJSON(
              taggedPath(basedir, 'steps', stepCompositeKey, tag),
              step,
              { overwrite: true }
            );
          }
        } else if (data.eventType === 'step_failed' && 'eventData' in data) {
          // step_failed: Terminal state with error
          // Uses writeExclusive on a lock file to atomically prevent concurrent
          // invocations from both failing the same step (TOCTOU race).
          const failedData = data.eventData as {
            error: unknown;
          };
          if (validatedStep) {
            const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
            const lockName = tag
              ? `${stepCompositeKey}.terminal.${tag}`
              : `${stepCompositeKey}.terminal`;
            const terminalLockPath = resolveWithinBase(
              basedir,
              '.locks',
              'steps',
              lockName
            );
            const claimed = await writeExclusive(terminalLockPath, '');
            if (!claimed) {
              throw new EntityConflictError(
                'Cannot modify step in terminal state'
              );
            }
            // The error field is SerializedData (Uint8Array) produced by
            // dehydrateStepError. We store it verbatim — consumers hydrate it
            // via hydrateStepError to reconstruct the original thrown value.
            step = {
              ...validatedStep,
              status: 'failed',
              error: failedData.error as Uint8Array,
              completedAt: now,
              updatedAt: now,
            };
            await writeJSON(
              taggedPath(basedir, 'steps', stepCompositeKey, tag),
              step,
              { overwrite: true }
            );
          }
        } else if (data.eventType === 'step_retrying' && 'eventData' in data) {
          // step_retrying: Sets status back to 'pending', records error
          // Reuse validatedStep from validation (already read above)
          const retryData = data.eventData as {
            error: unknown;
            retryAfter?: Date;
          };
          if (validatedStep) {
            const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
            step = {
              ...validatedStep,
              status: 'pending',
              error: retryData.error as Uint8Array,
              retryAfter: retryData.retryAfter,
              updatedAt: now,
            };
            await writeJSON(
              taggedPath(basedir, 'steps', stepCompositeKey, tag),
              step,
              { overwrite: true }
            );
          }
        } else if (
          // Hook lifecycle events
          data.eventType === 'hook_created' &&
          'eventData' in data
        ) {
          const hookData =
            data.eventData as HookCreatedEventRequest['eventData'];

          // Atomically claim the token using an exclusive-create constraint file.
          // This avoids the TOCTOU race of the previous read-all-then-check approach.
          const constraintPath = hookTokenClaimPath(basedir, hookData.token);
          // Persist `eventId` in the claim so concurrent / cross-
          // process retries can converge on a single canonical
          // `hook_created` event path. See the recovery comment
          // below.
          const claimContent = JSON.stringify({
            token: hookData.token,
            hookId: data.correlationId,
            runId: effectiveRunId,
            eventId,
            tokenRetentionUntil: hookData.tokenRetentionUntil,
          });

          // Serialize claim replacement so a committed disposal or terminal
          // run cannot race its successor and create a spurious conflict
          // (issue #2778). Missing claim caches are rebuilt from the event log;
          // stale owners are removed before the successor is admitted.
          const claimResult = await withHookTokenClaimLock(
            basedir,
            hookData.token,
            async (signal) => {
              let existingClaim = await readHookTokenClaim(constraintPath);
              if (!existingClaim) {
                // Repair a missing or corrupt claim from the event log.
                signal.throwIfAborted();
                await deleteJSON(constraintPath);
                await rebuildLiveHookByTokenFromEventLog(
                  basedir,
                  hookData.token,
                  tag
                );
                existingClaim = await readHookTokenClaim(constraintPath);
              }

              if (!existingClaim) {
                signal.throwIfAborted();
                assert(await writeExclusive(constraintPath, claimContent));
                return { status: 'claimed' as const };
              }
              if (
                existingClaim.runId === effectiveRunId &&
                existingClaim.hookId === data.correlationId
              ) {
                return { status: 'owned' as const, claim: existingClaim };
              }
              if (
                !(await isHookTokenClaimReleasable(basedir, existingClaim, tag))
              ) {
                return { status: 'conflict' as const, claim: existingClaim };
              }

              // The previous owner committed its release but did not finish
              // cleanup. Remove that lifetime before admitting a successor.
              signal.throwIfAborted();
              await deleteJSON(constraintPath);
              if (existingClaim.hookId) {
                await deleteJSON(
                  taggedPath(basedir, 'hooks', existingClaim.hookId, tag)
                );
                await deleteJSON(
                  hookRecoveryMarkerPath(
                    basedir,
                    hookData.token,
                    existingClaim.runId,
                    existingClaim.hookId
                  )
                );
                await deleteHookByRunMarker(
                  basedir,
                  existingClaim.runId,
                  existingClaim.hookId,
                  tag
                );
              }
              signal.throwIfAborted();
              assert(await writeExclusive(constraintPath, claimContent));
              return { status: 'claimed' as const };
            }
          );

          // The claim and Hook entity are written before `hook_created`, so a
          // crash can leave either cache without the durable event. A retry by
          // the same Hook adopts the eventId stored in its claim, making all
          // processes publish one canonical event path. Legacy claims use the
          // recovery marker below to pin that eventId.
          if (claimResult.status === 'owned') {
            const existingClaim = claimResult.claim;
            // Current claims carry the canonical eventId. For legacy claims,
            // first honor an event already published by the old writer;
            // otherwise atomically pin a new canonical id in a sidecar.
            let canonicalEventId: string;
            if (existingClaim.eventId) {
              canonicalEventId = existingClaim.eventId;
            } else {
              const alreadyPublishedEventId =
                await findExistingHookCreatedEventId(
                  basedir,
                  effectiveRunId,
                  data.correlationId
                );
              if (alreadyPublishedEventId !== null) {
                // Repair a pre-upgrade crash between event and entity writes.
                await repairHookEntityFromPersistedEvent(
                  basedir,
                  effectiveRunId,
                  data.correlationId,
                  alreadyPublishedEventId,
                  tag
                );
                throw new EntityConflictError(
                  `Hook "${data.correlationId}" already created`
                );
              }
              const pinned = await pinCanonicalEventIdForLegacyClaim(
                basedir,
                hookData.token,
                effectiveRunId,
                data.correlationId,
                eventId
              );
              if (pinned === null) {
                // An unreadable winning marker cannot safely be recovered.
                throw new EntityConflictError(
                  `Hook "${data.correlationId}" already created`
                );
              }
              canonicalEventId = pinned;
            }

            // Pinned: this id is the convergence point for every writer of
            // this hook, so it must not be bumped past a slot collision. A
            // collision here means the canonical event is already published,
            // which is exactly the duplicate the handler below repairs from.
            eventId = canonicalEventId;
            eventIdPinned = true;
            const canonicalCreatedAt =
              ulidToDate(eventId.replace(/^evnt_/, '')) ?? now;
            event = {
              ...data,
              // The first claim fixes the retention deadline even when its
              // writer crashes before publishing hook_created.
              eventData: {
                ...data.eventData,
                tokenRetentionUntil: existingClaim.tokenRetentionUntil,
              },
              runId: effectiveRunId,
              eventId,
              createdAt: canonicalCreatedAt,
              specVersion: effectiveSpecVersion,
            };
          }

          if (claimResult.status === 'conflict') {
            const existingClaim = claimResult.claim;
            const conflictEvent: Event = {
              eventType: 'hook_conflict',
              correlationId: data.correlationId,
              eventData: {
                token: hookData.token,
                conflictingRunId: existingClaim.runId,
              },
              runId: effectiveRunId,
              eventId,
              createdAt: now,
              specVersion: effectiveSpecVersion,
            };

            await storeEvent(conflictEvent);
            const resolveData =
              params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            return {
              event: stripEventDataRefs(conflictEvent, resolveData),
              run,
              step,
              hook: undefined,
            };
          }

          // Defer the Hook entity write until the event publish succeeds. A
          // retry may carry different metadata, so writing it first could make
          // the entity disagree with the already-committed event (PR #2295).
          const persistedHookData =
            event.eventData as HookCreatedEventRequest['eventData'];
          hook = {
            runId: effectiveRunId,
            hookId: data.correlationId,
            token: persistedHookData.token,
            metadata: persistedHookData.metadata,
            ownerId: 'local-owner',
            projectId: 'local-project',
            environment: 'local',
            // Keep converging entity writes byte-identical.
            createdAt: event.createdAt,
            specVersion: effectiveSpecVersion,
            isWebhook: persistedHookData.isWebhook ?? false,
            isSystem: persistedHookData.isSystem ?? false,
            tokenRetentionUntil: persistedHookData.tokenRetentionUntil,
          };
          hookEntityWriteOptions =
            claimResult.status === 'owned' ? { overwrite: true } : undefined;

          // Index entries before the event publish (see hook-index.ts
          // crash-ordering invariant). `eventId` is final here — the
          // dedup-recovery branch above already reassigned it to the
          // canonical id when applicable.
          await writeHookCreatedIndexEntries(
            basedir,
            hookData.token,
            effectiveRunId,
            data.correlationId,
            eventId,
            tag
          );
        } else if (data.eventType === 'hook_disposed') {
          // hook_disposed: Deletes hook entity, rejects duplicates.
          // Uses writeExclusive on a lock file to atomically prevent concurrent
          // invocations from both disposing the same hook (TOCTOU race).
          // The lock doubles as the durable disposal marker consulted by the
          // hook_created claim path and the event-log rebuild (see
          // `isHookDisposalCommitted`), which is why it must be written
          // before any of the destructive deletes below.
          const lockPath = hookDisposeLockPath(
            basedir,
            data.correlationId,
            tag
          );
          const claimed = await writeExclusive(lockPath, '');
          if (!claimed) {
            throw new EntityConflictError(
              `Hook "${data.correlationId}" already disposed`
            );
          }
          // Read the hook to get its token before deleting
          const hookPath = taggedPath(
            basedir,
            'hooks',
            data.correlationId,
            tag
          );
          const existingHook = await readJSONWithFallback(
            basedir,
            'hooks',
            data.correlationId,
            HookSchema,
            tag
          );
          if (existingHook) {
            // Release the token claim to free up the token for reuse —
            // but only if it still points at this hook. A claimant that
            // force-released this hook's stale claim (see
            // `isHookTokenClaimReleasable`) may already hold a fresh
            // claim for the token; deleting unconditionally here would
            // destroy that live claim and transiently break token
            // uniqueness. Also delete this hook's recovery marker (if
            // any) for disk hygiene. The marker's filename hash
            // includes `(token, runId, hookId)` so different
            // lifetimes never collide, but cleaning up reduces disk
            // leak for hooks that go through the recovery path.
            await releaseHookTokenClaimIfOwnedBy(
              basedir,
              existingHook.token,
              existingHook.runId,
              existingHook.hookId
            );
            await deleteJSON(
              hookRecoveryMarkerPath(
                basedir,
                existingHook.token,
                existingHook.runId,
                existingHook.hookId
              )
            );
          }
          await deleteJSON(hookPath);
          await deleteHookByRunMarker(
            basedir,
            effectiveRunId,
            data.correlationId,
            tag
          );
        } else if (data.eventType === 'wait_created' && 'eventData' in data) {
          // wait_created: Creates wait entity with status 'waiting'.
          // Atomic claim on a per-(runId, correlationId) constraint file
          // ensures duplicate wait_created from concurrent invocations
          // surfaces as EntityConflictError (replaces a prior TOCTOU
          // read-then-check that could let both writers through).
          const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          const waitCreatedLockName = tag
            ? `${waitCompositeKey}.created.${tag}`
            : `${waitCompositeKey}.created`;
          const waitCreatedLockPath = resolveWithinBase(
            basedir,
            '.locks',
            'waits',
            waitCreatedLockName
          );
          const waitCreatedClaimed = await writeExclusive(
            waitCreatedLockPath,
            ''
          );
          if (!waitCreatedClaimed) {
            throw new EntityConflictError(
              `Wait "${data.correlationId}" already exists`
            );
          }
          const waitData = data.eventData as {
            resumeAt?: Date;
          };
          wait = {
            waitId: waitCompositeKey,
            runId: effectiveRunId,
            status: 'waiting',
            resumeAt: waitData.resumeAt,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
            specVersion: effectiveSpecVersion,
          };
          await writeJSON(
            taggedPath(basedir, 'waits', waitCompositeKey, tag),
            wait
          );
        } else if (data.eventType === 'wait_completed') {
          // wait_completed: Transitions wait to 'completed', rejects duplicates.
          // Uses writeExclusive on a lock file to atomically prevent concurrent
          // invocations from both completing the same wait (TOCTOU race).
          const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;
          const waitLockName = tag
            ? `${waitCompositeKey}.completed.${tag}`
            : `${waitCompositeKey}.completed`;
          const lockPath = resolveWithinBase(
            basedir,
            '.locks',
            'waits',
            waitLockName
          );
          const claimed = await writeExclusive(lockPath, '');
          if (!claimed) {
            throw new EntityConflictError(
              `Wait "${data.correlationId}" already completed`
            );
          }
          const existingWait = await readJSONWithFallback(
            basedir,
            'waits',
            waitCompositeKey,
            WaitSchema,
            tag
          );
          if (!existingWait) {
            // Clean up the lock file we just claimed — the wait doesn't exist
            await fs.unlink(lockPath).catch(() => {});
            throw new WorkflowWorldError(
              `Wait "${data.correlationId}" not found`
            );
          }
          // The lock file (writeExclusive above) already prevents concurrent
          // completions — no additional status check needed.
          wait = {
            ...existingWait,
            status: 'completed',
            completedAt: now,
            updatedAt: now,
          };
          await writeJSON(
            taggedPath(basedir, 'waits', waitCompositeKey, tag),
            wait,
            { overwrite: true }
          );
        }
        // Note: hook_received events are stored in the event log but don't
        // modify the Hook entity (which doesn't have a payload field)

        // Store event using composite key {runId}-{eventId}.
        //
        // `writeExclusive` (O_CREAT|O_EXCL via temp-file + hard-link)
        // is the cross-process atomic publish primitive: if the file
        // already exists, returns false instead of overwriting. This
        // is critical for the hook_created dedup-recovery convergence
        // (above) — two workers that adopt the same canonical eventId
        // race here; whoever links the file first wins, the loser
        // throws EntityConflictError, and the runtime's existing
        // concurrent-replay catch path at suspension-handler.ts:142
        // swallows it. For all other event types, eventIds are
        // monotonic ULIDs (globally unique by construction) so a
        // collision indicates a real bug and EntityConflictError is
        // also the right surface — same shape as step_created's
        // claim-file behavior.
        // Last-instant re-validation for `hook_received` (see the acceptance
        // check above). The per-hook in-process lock already serializes
        // resume vs. dispose within one storage instance; this second check
        // narrows the cross-instance window (independent lock maps, shared
        // filesystem) to the single event write below, matching the
        // module's convention that the on-disk lock file — not the
        // in-process mutex — is the durable source of truth.
        if (
          data.eventType === 'hook_received' &&
          data.correlationId &&
          (await isHookDisposalCommitted(basedir, data.correlationId, tag))
        ) {
          throw new HookNotFoundError(data.correlationId);
        }

        let eventPath = taggedPath(
          basedir,
          'events',
          `${effectiveRunId}-${eventId}`,
          tag
        );
        // Capture the serialized payload before the write's `await` so the
        // cached snapshot can't observe a later mutation (see
        // rememberStoredEvent).
        let serializedEvent = JSON.stringify(event, jsonReplacer, 2);

        /**
         * Moves this event to the next free slot after a lost publish, and
         * reports whether it could.
         *
         * A slot id is a position in the run's log, not a globally unique
         * token, so losing the publish means another writer took the
         * position — an ordinary concurrent write. The World's contract is to
         * bump and commit rather than reject: `create` must not fail for a
         * reason its caller could not have avoided. Bumping is refused for:
         *
         * - ULID-numbered runs, where ids ARE globally unique and a collision
         *   really is a duplicate publish that must surface;
         * - ids pinned by a durable claim (`hook_created`'s canonical id,
         *   `hook_received`'s resume claim), which exist precisely so two
         *   writers converge on ONE event — bumping would publish a second.
         *
         * The pinned case can only collide across storage instances sharing a
         * directory: within one instance every slot comes from the same
         * monotonic counter, so no two writers ever draw the same one.
         */
        const bumpEventSlot = async (attempt: number): Promise<boolean> => {
          const current = eventIdToSlot(eventId);
          if (eventIdPinned || current === null) {
            return false;
          }
          // Every failure advances the counter by at least one, so this
          // terminates even under heavy contention. Rescan periodically so a
          // batch committed by another instance is skipped in one step rather
          // than one slot at a time.
          const slot = await drawEventSlot(effectiveRunId, {
            rescan: attempt > 0 && attempt % 8 === 0,
            atLeast: current + 1,
          });
          if (slot === null) {
            return false;
          }
          eventId = slotToEventId(slot);
          event = { ...event, eventId };
          eventPath = taggedPath(
            basedir,
            'events',
            `${effectiveRunId}-${eventId}`,
            tag
          );
          serializedEvent = JSON.stringify(event, jsonReplacer, 2);
          return true;
        };

        // Cross-process terminal-run guard for `hook_received`. A terminal
        // transition (run_completed / run_failed / run_cancelled) in ANY
        // process (1) publishes a durable `runTerminalMarkerPath` marker and
        // (2) reaps the run's staged hook_received events, both BEFORE it
        // writes the terminal run state or appends its terminal event (see
        // the terminal-transition block earlier in this function). In-memory
        // locks cannot close the shared-filesystem race this backend
        // explicitly supports, and a published event file is immediately
        // visible to `events.list()` in other processes — so it can never be
        // "rolled back" after the fact. Instead, the event stays INVISIBLE
        // to readers until a single atomic filesystem operation decides its
        // fate:
        //
        //   1. (fast path) reject if the run is already terminal — by
        //      marker, or by run state for runs that predate the marker —
        //      so the common case never creates a file.
        //   2. STAGE the event at a non-reader-visible path under `.locks`.
        //   3. re-CHECK the terminal marker; reject if present.
        //   4. PROMOTE the staged file into `events/` with an atomic hard
        //      link; reject if the staged file was reaped (`'missing'`).
        //
        // Correctness: the reap's `unlink` and step 4's `link` target the
        // same staged file, so the filesystem serializes them — exactly one
        // wins. If the link wins, the event was reader-visible before the
        // reap completed, and therefore before the terminal state and
        // terminal event were written: acceptance happened-before the
        // termination and legitimately precedes it. If the unlink wins,
        // promotion fails and the event is never visible to any reader —
        // there is nothing to roll back. A resume that stages after the
        // reap has passed necessarily stages after the marker was
        // committed, so step 3 rejects it. Rejections before step 4 unlink
        // a file no reader can see.
        let eventPublished = false;
        for (let attempt = 0; ; attempt++) {
          if (data.eventType === 'hook_received') {
            // Step 1: fast path. The marker is the authoritative durable
            // signal; the run-state read additionally rejects runs whose
            // terminal state was written without a marker (e.g. runs that
            // terminated on an older storage version).
            const terminalByMarker = await isRunTerminalCommitted(
              basedir,
              effectiveRunId,
              tag
            );
            const runNow = terminalByMarker
              ? null
              : await readJSONWithFallback(
                  basedir,
                  'runs',
                  effectiveRunId,
                  WorkflowRunSchema,
                  tag
                );
            if (
              terminalByMarker ||
              (runNow && isTerminalWorkflowRunStatus(runNow.status))
            ) {
              throw new RunExpiredError(
                `Workflow run "${effectiveRunId}" is already in a terminal state`
              );
            }

            const stagedPath = pendingHookEventPath(
              basedir,
              effectiveRunId,
              eventId,
              tag
            );
            const staged = await writeExclusive(stagedPath, serializedEvent);
            if (!staged) {
              // The staging path can be occupied by a previous crashed
              // attempt of this very event (which never promoted), or, under
              // slot ids, by a concurrent writer holding the same position.
              // Both are handled the same way: fall through to the bump
              // below, which moves off the position when it can and surfaces
              // the conflict when it cannot.
              if (await bumpEventSlot(attempt)) {
                continue;
              }
              throw new EntityConflictError(
                `Event "${eventId}" already exists for run "${effectiveRunId}"`
              );
            }
            try {
              if (await isRunTerminalCommitted(basedir, effectiveRunId, tag)) {
                throw new RunExpiredError(
                  `Workflow run "${effectiveRunId}" is already in a terminal state`
                );
              }
              const promoted = await promoteExclusive(stagedPath, eventPath);
              if (promoted === 'missing') {
                // A terminal transition reaped the staged file between the
                // check and the link — the atomic loss of the arbitration.
                throw new RunExpiredError(
                  `Workflow run "${effectiveRunId}" is already in a terminal state`
                );
              }
              eventPublished = promoted === 'linked';
            } finally {
              // The staged path is not reader-visible; removing it is pure
              // cleanup on every outcome (already gone when reaped).
              await deleteJSON(stagedPath).catch(() => {});
            }
          } else {
            eventPublished = await writeExclusive(eventPath, serializedEvent);
          }

          if (eventPublished || !(await bumpEventSlot(attempt))) {
            break;
          }
        }

        if (!eventPublished) {
          // For `hook_created`, losing the event publish means the
          // event was already committed at this exact (canonical)
          // path. The original publisher may have crashed between
          // its event publish and its deferred hook-entity write
          // (the inverse of the crash window the deferral closes),
          // leaving an event-first orphan: the event is in the log
          // but the entity is missing and the hook is unresolvable.
          // Repair the entity from the PERSISTED event's payload
          // (never the retry's — different retry metadata must not
          // change committed state) before surfacing the benign
          // duplicate to the runtime's concurrent-replay catch path.
          if (data.eventType === 'hook_created' && data.correlationId) {
            await repairHookEntityFromPersistedEvent(
              basedir,
              effectiveRunId,
              data.correlationId,
              eventId,
              tag
            );
          }
          throw new EntityConflictError(
            `Event "${eventId}" already exists for run "${effectiveRunId}"`
          );
        }

        // The event is now committed; cache it so an immediate sequential
        // replay can serve it without rereading from disk.
        rememberStoredEvent(event, eventPath, serializedEvent);

        // Point the resume claim at where the event actually landed. An
        // unpinned publish bumps past occupied slots, so the id the claim
        // recorded before the append can be stale; leaving it stale would
        // send every later reader of this resume down the `resumeId` scan
        // instead of the single read the claim exists to provide. Plain
        // overwrite, not exclusive-create: the claim is already this
        // writer's, and only the eventId changes.
        if (
          data.eventType === 'hook_received' &&
          params?.resumeId &&
          resumeClaimRecordedId !== null &&
          resumeClaimRecordedId !== eventId
        ) {
          await write(
            hookResumeClaimPath(basedir, effectiveRunId, params.resumeId),
            JSON.stringify({
              runId: effectiveRunId,
              resumeId: params.resumeId,
              hookId: data.correlationId,
              eventId,
              ...(params.resumePayloadDigest
                ? { payloadDigest: params.resumePayloadDigest }
                : {}),
            } satisfies z.infer<typeof HookResumeClaimSchema>),
            { overwrite: true }
          );
        }

        // Write the hook entity ONLY now that the event publish has
        // committed. Doing this earlier (in the `hook_created`
        // branch above) would mutate an already-committed hook
        // entity with the retry's payload before the event publish
        // proved whether this attempt was repairing a missing event
        // or just colliding with an already-published `hook_created`.
        // The branch sets `hookEntityWriteOptions` iff this event
        // type writes an entity.
        if (hook && data.eventType === 'hook_created') {
          // Marker before entity (see hook-index.ts crash-ordering
          // invariant).
          await writeHookByRunMarker(basedir, hook.runId, hook.hookId, tag);
          await writeJSON(
            taggedPath(basedir, 'hooks', hook.hookId, tag),
            hook,
            hookEntityWriteOptions
          );
        }

        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        const filteredEvent = stripEventDataRefs(event, resolveData);

        // For run_started: preload one page of events so the runtime can skip
        // the initial events.list call when hasMore is false.
        let events: Event[] | undefined;
        let cursor: string | null | undefined;
        let hasMore: boolean | undefined;
        if (data.eventType === 'run_started' && run) {
          const allEvents = await paginatedFileSystemQuery({
            directory: path.join(basedir, 'events'),
            schema: EventSchema,
            cachedItems: eventCache,
            filePrefix: `${effectiveRunId}-`,
            sortOrder: 'asc',
            limit: 1000,
            getCreatedAt: getObjectCreatedAt('evnt'),
            getId: (e) => e.eventId,
            getSortKey: eventSortKey,
          });
          events = allEvents.data;
          cursor = allEvents.cursor;
          hasMore = allEvents.hasMore;
        }

        // Inline-delta optimization: a writer can pass `sinceCursor` (the
        // cursor of the event log as it last saw it). We return the delta of
        // events written strictly after that cursor — exactly what an
        // `events.list({ cursor: sinceCursor, sortOrder: 'asc' })` would
        // return right now — so the caller can skip a redundant round-trip.
        //
        // This is computed against the same on-disk log the list path
        // reads, so it captures everything the fetch would: the event just
        // written, any attr_set a step body wrote, and any in-band events
        // (e.g. hook_received, wait_completed) another writer appended since
        // the cursor. That equivalence is what makes skipping the fetch safe
        // — a missed in-band event cannot diverge replay because the delta
        // is the fetch.
        //
        // Any event type qualifies. The write itself decides nothing here;
        // whether the delta is worth requesting is the caller's call, and
        // the runtime asks on every non-turbo write so each response carries
        // the log forward. `resolveData` matches the list path so eventData
        // refs are handled identically.
        if (typeof params?.sinceCursor === 'string') {
          // Intentionally no `limit`: this returns a single default-size page,
          // unlike the `events.list` path which loops `while (hasMore)` to
          // exhaustion. That is safe — and must NOT be "fixed" by paginating
          // here — because the contract is single-page-or-fallback, not
          // complete-delta. When the delta overflows one page,
          // paginatedFileSystemQuery sets `hasMore: true` and slices `data` to
          // the page (see fs.ts), which we forward verbatim below. The SDK
          // consume side (runtime.ts) only stashes the delta when `!hasMore`
          // and otherwise falls back to the exhaustive `events.list` loop, so a
          // truncated page is never consumed as if it were the full delta.
          const delta = await paginatedFileSystemQuery({
            directory: path.join(basedir, 'events'),
            schema: EventSchema,
            filePrefix: `${effectiveRunId}-`,
            sortOrder: 'asc',
            cursor: params.sinceCursor,
            getCreatedAt: getObjectCreatedAt('evnt'),
            getId: (e) => e.eventId,
            getSortKey: eventSortKey,
          });
          events =
            resolveData === 'none'
              ? delta.data.map((e) => stripEventDataRefs(e, resolveData))
              : delta.data;
          cursor = delta.cursor;
          hasMore = delta.hasMore;
        }

        // Return EventResult with event and any created/updated entity
        return {
          event: filteredEvent,
          run,
          step,
          hook,
          wait,
          events,
          cursor,
          hasMore,
          ...(stepCreatedLazily ? { stepCreated: true } : {}),
          // Per-run event ceiling (mirrors the Vercel World).
          ...(run ? { maxEvents: getMaxEventsPerRun() } : {}),
        };
      } // end createImpl
    },

    async get(runId, eventId, params) {
      assertSafeEntityId('runId', runId);
      assertSafeEntityId('eventId', eventId);
      const compositeKey = `${runId}-${eventId}`;
      const event = await readJSONWithFallback(
        basedir,
        'events',
        compositeKey,
        EventSchema,
        tag
      );
      if (!event) {
        throw new Error(`Event ${eventId} in run ${runId} not found`);
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return stripEventDataRefs(event, resolveData);
    },

    async list(params) {
      const { runId } = params;
      assertSafeEntityId('runId', runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, 'events'),
        schema: EventSchema,
        cachedItems: eventCache,
        filePrefix: `${runId}-`,
        // Events in chronological order (oldest first) by default,
        // different from the default for other list calls.
        sortOrder: params.pagination?.sortOrder ?? 'asc',
        limit: params.pagination?.limit,
        cursor: params.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt('evnt'),
        getId: (event) => event.eventId,
        getSortKey: eventSortKey,
      });

      // If resolveData is "none", remove eventData from events
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((event) =>
            stripEventDataRefs(event, resolveData)
          ),
        };
      }

      return result;
    },

    async listByCorrelationId(params) {
      const correlationId = params.correlationId;
      assertSafeEntityId('correlationId', correlationId);
      assertSafeEntityId('runId', params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, 'events'),
        schema: EventSchema,
        cachedItems: eventCache,
        // Scoped to the run's own event files, since a correlation id
        // identifies a step or wait only within its run: a slot-numbered
        // `step_…001` names the first step of every such run, so an unscoped
        // scan would answer with one event per run.
        filePrefix: `${params.runId}-`,
        filter: (event) => event.correlationId === correlationId,
        // Events in chronological order (oldest first) by default,
        // different from the default for other list calls.
        sortOrder: params.pagination?.sortOrder ?? 'asc',
        limit: params.pagination?.limit,
        cursor: params.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt('evnt'),
        getId: (event) => event.eventId,
        getSortKey: eventSortKey,
      });

      // If resolveData is "none", remove eventData from events
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((event) =>
            stripEventDataRefs(event, resolveData)
          ),
        };
      }

      return result;
    },
  };

  /**
   * The report half of bump-and-report: the events sitting on the slots
   * between the one the writer asked for and the one its write landed on.
   *
   * Wrapped around `create` rather than folded into it because `create` has a
   * dozen commit points (dedup recovery, hook conflict, lazy step creation)
   * and the report is the same at every one of them: read the committed id,
   * read back what is below it.
   *
   * The read is a directory scan, so it only runs when the write actually
   * skipped a slot. `hasMore` says the set is a lower bound: another instance
   * may hold a lower slot it has not published yet, and a draw whose publish
   * was lost leaves one permanently empty.
   */
  async function reportSkippedSlots(
    result: EventResult,
    askedFor: number,
    resolveData: ResolveData
  ): Promise<EventResult> {
    if (!result.event) {
      return result;
    }
    const committedSlot = eventIdToSlot(result.event.eventId);
    if (
      committedSlot === null ||
      askedFor < FIRST_EVENT_SLOT ||
      committedSlot <= askedFor + 1
    ) {
      return result;
    }
    const span = committedSlot - askedFor - 1;
    const page = await storage.list({
      runId: result.event.runId,
      pagination: {
        cursor: `${SORT_KEY_CURSOR_PREFIX}${slotToEventId(askedFor)}`,
        limit: span,
        sortOrder: 'asc',
      },
      resolveData,
    });
    // The cursor is exclusive and the page is in slot order, so a dense log
    // yields exactly the skipped slots. A hole lets the page reach past the
    // committed slot, which is this writer's own event and anything a later
    // writer already published: neither is something it skipped over.
    const committedEventId = result.event.eventId;
    const events = page.data.filter(
      (event) => event.eventId < committedEventId
    );
    return {
      ...result,
      events,
      hasMore: events.length < committedSlot - askedFor - 1,
    };
  }

  /**
   * The fence half: refuse a write whose writer is blocked on something the log
   * has already settled above the slot it asked for.
   *
   * Runs before `storage.create` rather than alongside the report, because a
   * rejection after the commit is worthless — the event it would have kept out
   * is already durable. The cost of being early is a window between this read
   * and the insert in which a resolution can still land unseen; that misses the
   * fence and degrades to plain bump-and-report, which is the behaviour without
   * it. Never the other way around: an event read here is committed, so a
   * rejection is never spurious.
   */
  async function fenceAwaitedResolutions(
    runId: string,
    askedFor: number,
    awaiting: readonly string[],
    resolveData: ResolveData
  ): Promise<void> {
    if (awaiting.length === 0 || askedFor < FIRST_EVENT_SLOT) {
      return;
    }
    const page = await storage.list({
      runId,
      pagination: {
        cursor: `${SORT_KEY_CURSOR_PREFIX}${slotToEventId(askedFor)}`,
        // One page, not a walk. A writer this far behind is not a case worth
        // paging for, and truncation loses a fence rather than inventing one.
        limit: AWAITED_RESOLUTION_SCAN_LIMIT,
        sortOrder: 'asc',
      },
      resolveData,
    });
    const blocking = findAwaitedResolution(page.data, awaiting);
    if (!blocking) {
      return;
    }
    // The whole unseen tail rides along, not just the offending event: the
    // client merges it into its log and restarts the replay, and a replay that
    // resumed knowing only about the resolution would immediately be stale
    // again on everything beside it.
    throw new PreconditionFailedError(awaitedResolutionMessage(blocking), {
      details: { events: page.data },
    });
  }

  const create = (async (
    runId: string,
    data: CreateEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> => {
    if (params?.eventCount === undefined) {
      return storage.create(runId, data, params);
    }
    const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    if (params.awaitingCorrelationIds?.length) {
      await fenceAwaitedResolutions(
        runId,
        params.eventCount,
        params.awaitingCorrelationIds,
        resolveData
      );
    }
    const result = await storage.create(runId, data, params);
    // `sinceCursor` and the skipped-slot report share `events`/`cursor`/
    // `hasMore`, and the runtime sends both on the same write. The delta wins:
    // the skipped slots all sit above the cursor, so it is a strict superset,
    // and it is the only one of the two that advances `cursor`. Narrowing
    // `events` to the report while leaving the delta's cursor would tell the
    // caller it has read a range it was only handed part of, and the rest
    // would never be fetched again.
    if (typeof params.sinceCursor === 'string') {
      return result;
    }
    return reportSkippedSlots(result, params.eventCount, resolveData);
  }) as LocalEventsStorage['create'];

  return { ...storage, create };
}
