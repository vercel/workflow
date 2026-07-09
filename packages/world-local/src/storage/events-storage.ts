import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  Event,
  EventResult,
  Hook,
  SerializedData,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import {
  applyAttributeChanges,
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
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
  readJSON,
  readJSONWithFallback,
  resolveWithinBase,
  taggedPath,
  write,
  writeExclusive,
  writeJSON,
} from '../fs.js';
import { stripEventDataRefs } from './filters.js';
import {
  getObjectCreatedAt,
  hookDisposeLockPath,
  hookRecoveryMarkerPath,
  hookTokenClaimPath,
  isHookDisposalCommitted,
  monotonicUlid,
  releaseHookTokenClaimIfOwnedBy,
} from './helpers.js';
import {
  deleteHookByRunMarker,
  writeHookByRunMarker,
  writeHookCreatedIndexEntries,
} from './hook-index.js';
import {
  deleteAllHooksForRun,
  rebuildLiveHookByTokenFromEventLog,
} from './hooks-storage.js';
import { handleLegacyEvent } from './legacy.js';
import { withRunFileLock } from './runs-storage.js';

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
// being module-level. The on-disk constraint / claim files remain
// the durable source of truth across processes; the in-process
// mutex is a per-instance optimization that closes a short race
// window in the dedup-recovery path. Per-instance scoping lets
// tests simulate cross-process behavior with two storage instances
// sharing one data directory (each instance has independent locks
// but a shared filesystem), exactly matching the cross-process
// semantics without spawning subprocesses.

const HookTokenClaimSchema = z.object({
  // The token-claim writer below has always persisted `hookId`, but
  // this read schema previously omitted it, which is the bug fixed
  // by https://github.com/vercel/workflow/issues/2283. `optional()`
  // is defensive: any claim file that somehow lacks the field still
  // parses (yielding `undefined`) and falls through to the cross-
  // hook conflict branch, matching pre-fix behavior.
  hookId: z.string().optional(),
  runId: z.string(),
  // `eventId` is the canonical hook_created event ID the claiming
  // worker committed to publishing. Persisting it here turns the
  // claim file into a durable convergence key for cross-worker /
  // cross-process retries (see comment on the hook_created branch).
  // `optional()` for backward compatibility: a legacy claim file
  // written before this field existed falls through to the recovery-
  // marker upgrade path, which atomically pins a canonical eventId
  // via a sidecar marker (also a `writeExclusive`).
  eventId: z.string().optional(),
});

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

async function readHookTokenClaim(
  constraintPath: string
): Promise<z.infer<typeof HookTokenClaimSchema> | null> {
  try {
    return await readJSON(constraintPath, HookTokenClaimSchema);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

/**
 * Whether a token claim held by another `(runId, hookId)` can never become
 * live again and may therefore be released by a new claimant:
 *
 *   - the claimed hook's disposal is committed (its dispose lock exists —
 *     the durable release of the claim file just hasn't landed yet, or was
 *     lost to a crash between the lock write and the claim delete), or
 *   - the owning run is terminal (the run-completion cleanup releases all
 *     of the run's claims, but a claimant can observe the claim in the
 *     window before that cleanup lands — or the cleanup crashed), or
 *   - the owning run does not exist (a claim can only be written during a
 *     suspension of an existing run, so an ownerless claim is debris).
 *
 * A claim from a mid-creation writer is never releasable: its owning run
 * exists and is non-terminal, and its dispose lock does not exist.
 */
async function isHookTokenClaimReleasable(
  basedir: string,
  claim: z.infer<typeof HookTokenClaimSchema>,
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
  return isTerminalWorkflowRunStatus(owningRun.status);
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
  const eventData = (persistedEvent.eventData ?? {}) as {
    token?: string;
    metadata?: SerializedData;
    isWebhook?: boolean;
    isSystem?: boolean;
  };
  if (typeof eventData.token !== 'string') {
    return;
  }
  const hook: Hook = {
    runId,
    hookId,
    token: eventData.token,
    metadata: eventData.metadata,
    ownerId: 'local-owner',
    projectId: 'local-project',
    environment: 'local',
    createdAt: persistedEvent.createdAt,
    specVersion: persistedEvent.specVersion,
    isWebhook: eventData.isWebhook ?? true,
    isSystem: eventData.isSystem ?? false,
  };
  // This path can repair events published by pre-index writers, so
  // (idempotently) index the persisted event before the entity write.
  await writeHookCreatedIndexEntries(
    basedir,
    eventData.token,
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

  return {
    clearCache,
    async create(runId, data, params): Promise<EventResult> {
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
      const isStepEvent =
        data.eventType === 'step_created' ||
        data.eventType === 'step_started' ||
        data.eventType === 'step_completed' ||
        data.eventType === 'step_failed' ||
        data.eventType === 'step_retrying';
      if (isStepEvent && runId && data.correlationId) {
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
      //
      // `hook_received` and `hook_disposed` share the same per-hook lock
      // so a resume's "hook exists and is not disposed, then append"
      // sequence is atomic with respect to the disposer's "write dispose
      // lock, delete entity, then append" sequence. Without this, a
      // resume that passed its existence check before the disposal began
      // could append its `hook_received` AFTER `hook_disposed` — an
      // ordering that is journaled durably and makes every subsequent
      // replay of the owning run diverge at that event
      // (https://github.com/vercel/workflow/issues/2781).
      const isHookLifecycleEvent =
        data.eventType === 'hook_created' ||
        data.eventType === 'hook_received' ||
        data.eventType === 'hook_disposed';
      if (isHookLifecycleEvent && runId && data.correlationId) {
        const lockKey = tag
          ? `${runId}-${data.correlationId}.hook.${tag}`
          : `${runId}-${data.correlationId}.hook`;
        return withInProcessLock(hookLocks, lockKey, () => createImpl());
      }
      return createImpl();

      async function createImpl(): Promise<EventResult> {
        // Most paths use the freshly-generated candidate eventId. The
        // hook_created dedup-recovery path below may reassign it to
        // the canonical eventId persisted in the durable token claim
        // so concurrent / cross-process workers converge on a single
        // event in the log.
        let eventId = `evnt_${monotonicUlid()}`;
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
                const runCreatedEventId = `evnt_${monotonicUlid()}`;
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
        const lazyStepStart =
          data.eventType === 'step_started' &&
          'eventData' in data &&
          !!data.eventData &&
          typeof (data.eventData as { stepName?: unknown }).stepName ===
            'string' &&
          (data.eventData as { input?: unknown }).input !== undefined;

        // Run terminal state validation
        if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
          const runTerminalEvents = [
            'run_started',
            'run_completed',
            'run_failed',
          ];

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
          if (
            runTerminalEvents.includes(data.eventType) ||
            data.eventType === 'run_cancelled'
          ) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${currentRun.status}"`
            );
          }

          // Creating new entities on terminal runs is not allowed. A lazy
          // step_started creates a step, so it is rejected here too — a bare
          // (non-lazy) step_started falls through to the step-validation
          // block below, which uses RunExpiredError for terminal runs.
          if (
            data.eventType === 'step_created' ||
            data.eventType === 'hook_created' ||
            data.eventType === 'wait_created' ||
            lazyStepStart
          ) {
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
        const stepEvents = [
          'step_started',
          'step_completed',
          'step_failed',
          'step_retrying',
        ];
        if (stepEvents.includes(data.eventType) && data.correlationId) {
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
        const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
        if (
          hookEventsRequiringExistence.includes(data.eventType) &&
          data.correlationId
        ) {
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
          'eventData' in event &&
          (event as { eventData?: Record<string, unknown> }).eventData
        ) {
          const { input: _strippedInput, ...rest } = (
            event as { eventData: Record<string, unknown> }
          ).eventData;
          (event as { eventData: Record<string, unknown> }).eventData = rest;
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
              return { run: currentRun };
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
            const lazyData = data.eventData as {
              stepName: string;
              input: any;
            };
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
              // step_created event). Its eventId is a fresh monotonic ULID.
              // Ordering vs. the step_started event row does not affect
              // correctness: the step_started consumer is a no-op and only
              // step_created flips hasCreatedEvent, so the end state is the
              // same whichever sorts first — this matches the resilient
              // run_started → run_created precedent in this file.
              const stepCreatedEventId = `evnt_${monotonicUlid()}`;
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
              await writeJSON(
                taggedPath(
                  basedir,
                  'events',
                  `${effectiveRunId}-${stepCreatedEventId}`,
                  tag
                ),
                stepCreatedEvent
              );
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
          const hookData = data.eventData as {
            token: string;
            metadata?: any;
            isWebhook?: boolean;
            isSystem?: boolean;
          };

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
          });

          // Bounded claim loop. A same-token claim can be observed in the
          // short window where its release is already committed but the
          // claim file itself is still on disk (or was just deleted):
          //
          //   - the claim vanished between the exclusive-create attempt
          //     and the ownership read → retry immediately;
          //   - the claim is held by a disposed hook or a terminal/missing
          //     run (`isHookTokenClaimReleasable`) → wait briefly for the
          //     in-flight releaser (the hook_disposed handler or the
          //     run-completion cleanup) to delete it, then reclaim; if it
          //     never does (the releaser crashed after committing its
          //     dispose lock / terminal status), release the stale claim
          //     ourselves and reclaim.
          //
          // Without this, a run claiming a token right after the previous
          // owner disposed it records a durable, spurious hook_conflict
          // (issue #2778). A genuinely live claim exits the loop on the
          // first iteration and falls through to the dedup / conflict
          // handling below.
          let tokenClaimed = false;
          let existingClaim: z.infer<typeof HookTokenClaimSchema> | null = null;
          let releasableObservations = 0;
          // A claim file that exists (exclusive-create keeps failing) but never
          // parses is debris: `writeExclusive` writes atomically, so a live
          // claim is always valid JSON — an unparseable one at the canonical
          // path is a corrupt/partial leftover. The releaser leaves it alone
          // (ownership is undeterminable), so nothing else reaps it and it would
          // block the token forever. Force-delete it after a few observations.
          let unparseableObservations = 0;
          for (let attempt = 0; attempt < 10; attempt++) {
            // When the claim is absent, the event log is the only durable
            // source that can distinguish a first hook from a crash-lost
            // token cache.
            if (!(await readHookTokenClaim(constraintPath))) {
              await rebuildLiveHookByTokenFromEventLog(
                basedir,
                hookData.token,
                tag
              );
            }
            tokenClaimed = await writeExclusive(constraintPath, claimContent);
            if (tokenClaimed) break;

            existingClaim = await readHookTokenClaim(constraintPath);
            if (!existingClaim) {
              // The claim either vanished (raced a releaser between the
              // exclusive-create attempt and this read → retry resolves it) or
              // exists but is unparseable. `readHookTokenClaim` can't tell them
              // apart, so count consecutive misses; once we're confident it is
              // not a transient race, delete the (presumed corrupt) file so the
              // token isn't blocked forever. `deleteJSON` is a no-op if it was
              // in fact a vanished-claim race.
              unparseableObservations++;
              if (unparseableObservations >= 3) {
                await deleteJSON(constraintPath);
              }
              continue;
            }
            if (
              existingClaim.runId === effectiveRunId &&
              existingClaim.hookId === data.correlationId
            ) {
              // Our own prior claim — dedup-recovery handling below.
              break;
            }
            if (
              !(await isHookTokenClaimReleasable(basedir, existingClaim, tag))
            ) {
              // Genuinely live claim — conflict handling below.
              break;
            }
            releasableObservations++;
            if (releasableObservations < 3) {
              // Give the in-flight releaser a moment to delete the claim.
              await new Promise((resolve) => setTimeout(resolve, 10));
            } else {
              // The releaser is not coming. Release the stale claim and
              // the hook entity it points at, mirroring the hook_disposed
              // cleanup.
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
              }
            }
            existingClaim = null;
          }

          // Recovery shape: the durable record of a successful hook
          // creation is the `hook_created` event in the event log. The
          // claim file and hook entity are written before the event,
          // and the three writes are NOT atomic, so a crash at any
          // point can leave one or two of them on disk without the
          // event. Treating those as "completed" would have the
          // suspension handler swallow the retry and permanently lose
          // the `hook_created` event from the log.
          //
          // When the dedup branch fires for the same `(runId, hookId)`,
          // we converge on the canonical `eventId` persisted in the
          // claim file by the original (winning) `writeExclusive`. By
          // adopting that eventId for this retry's event write — and
          // letting the outer no-overwrite `writeJSON` for the event
          // throw `EntityConflictError` on collision — concurrent /
          // cross-process workers either:
          //   - publish the same event at the same path exactly once
          //     (the loser's `writeJSON` throws EntityConflictError,
          //     which the runtime's existing concurrent-replay catch
          //     path at suspension-handler.ts:142 swallows), or
          //   - converge on a single recovery write when the prior
          //     claim was orphaned by a crash before the event landed.
          //
          // The legacy fallback (`existingClaim.eventId` undefined)
          // is for claim files written before this field was added —
          // those probe the event log directly and fall through to a
          // fresh-eventId recovery write. The legacy path does not
          // converge across workers but cannot regress behavior for
          // freshly-written claims.
          //
          // The `withHookLock` in-process mutex above keeps two same-
          // tick in-process callers from racing into this branch with
          // the winner mid-write, but is not sufficient across
          // processes — the durable convergence key (`claim.eventId`)
          // is what closes the cross-process race.
          let writeHookEntityWithOverwrite = false;

          if (!tokenClaimed) {
            if (
              existingClaim?.runId === effectiveRunId &&
              existingClaim.hookId === data.correlationId
            ) {
              // Adopt a canonical eventId for the recovery write. The
              // outer event publish (`writeExclusive(eventPath)`)
              // either succeeds (we publish the canonical event,
              // repairing a partial write left by the original
              // claimant) or returns `false` and we throw
              // `EntityConflictError` (the event was already
              // published — a real duplicate). Either way the log
              // ends with exactly one `hook_created` event for this
              // `(runId, hookId)`.
              //
              // The canonical eventId comes from one of two places:
              //
              //   - `existingClaim.eventId` for claims written by
              //     this version (the writer above persists the
              //     candidate eventId atomically with the claim).
              //     The eventId is durable, so the outer
              //     `writeExclusive(eventPath)` alone is enough to
              //     arbitrate publication: it fails iff the event
              //     was already published at that exact path.
              //
              //   - The recovery-marker sidecar for legacy claims
              //     written before `eventId` was persisted inline
              //     in the claim. The marker is itself a
              //     `writeExclusive`, so the first retry pins its
              //     candidate eventId as canonical and subsequent
              //     retries adopt it. Without this, two processes
              //     both reading the same legacy claim would each
              //     generate their own eventId, land their
              //     `writeExclusive(eventPath)` calls at different
              //     paths, and append two events.
              //
              //     For legacy claims we also must probe the event
              //     log for an existing `hook_created` event BEFORE
              //     pinning a canonical eventId: the pre-upgrade
              //     writer may have already published the event
              //     with its own eventId, and the marker has no way
              //     of knowing that eventId after the fact. Without
              //     this probe, a post-upgrade retry would pin a
              //     different eventId, write a hook entity, and
              //     publish a duplicate event at the marker's path.
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
                  // The pre-upgrade writer may have crashed between
                  // its event publish and its hook entity write —
                  // repair the entity from the persisted event's
                  // payload before surfacing the benign duplicate.
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
                  // Lost the marker race and the marker file is
                  // unreadable (extremely rare; corrupted disk).
                  // Treat as a real duplicate so the runtime's
                  // concurrent-replay catch path swallows this
                  // attempt instead of risking divergent
                  // publication.
                  throw new EntityConflictError(
                    `Hook "${data.correlationId}" already created`
                  );
                }
                canonicalEventId = pinned;
              }

              // Rebuild `event` with the canonical eventId and a
              // deterministic `createdAt` derived from the eventId
              // (a ULID) so two workers writing the same event
              // produce byte-identical content.
              eventId = canonicalEventId;
              const canonicalCreatedAt =
                ulidToDate(eventId.replace(/^evnt_/, '')) ?? now;
              event = {
                ...data,
                runId: effectiveRunId,
                eventId,
                createdAt: canonicalCreatedAt,
                specVersion: effectiveSpecVersion,
              };
              writeHookEntityWithOverwrite = true;
            } else {
              // Cross-hook / cross-run conflict: a different
              // (runId, hookId) holds this token. Create a
              // hook_conflict event so the workflow can fail
              // gracefully when the hook is awaited.
              const conflictEvent: Event = {
                eventType: 'hook_conflict',
                correlationId: data.correlationId,
                eventData: {
                  token: hookData.token,
                  ...(existingClaim
                    ? { conflictingRunId: existingClaim.runId }
                    : {}),
                },
                runId: effectiveRunId,
                eventId,
                createdAt: now,
                specVersion: effectiveSpecVersion,
              };

              // Persist and cache the conflict event (create-only,
              // same path the read cache keys on) so an immediate
              // replay can serve it without rereading from disk.
              await storeEvent(conflictEvent);

              const resolveData =
                params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
              const filteredEvent = stripEventDataRefs(
                conflictEvent,
                resolveData
              );

              // Return EventResult with conflict event (no hook entity created)
              return {
                event: filteredEvent,
                run,
                step,
                hook: undefined,
              };
            }
          }

          // Compute the hook entity now, but defer its write until
          // AFTER the outer event publish at the bottom of this
          // function commits. The retry path can reach this branch
          // for a hook whose `hook_created` event was already
          // published successfully (an "already-committed
          // duplicate"); in that case the outer `writeExclusive`
          // for the event will return false and we will throw
          // `EntityConflictError`. Writing the hook entity here
          // first would mutate already-committed durable state with
          // the retry's payload (e.g. different `metadata` or
          // `isWebhook`) before the event publish proved which
          // outcome we are in — leaving the entity and event log
          // inconsistent. By deferring, the entity is only written
          // when the publish actually succeeds (first writer or
          // orphan recovery). See pranaygp's review on PR #2295 for
          // the karthikscale3 repro.
          hook = {
            runId: effectiveRunId,
            hookId: data.correlationId,
            token: hookData.token,
            metadata: hookData.metadata,
            ownerId: 'local-owner',
            projectId: 'local-project',
            environment: 'local',
            // Use the (possibly canonical) event's createdAt so two
            // workers writing the same hook entity produce byte-
            // identical content during convergence.
            createdAt: event.createdAt,
            // Propagate specVersion from the event to the hook entity
            specVersion: effectiveSpecVersion,
            isWebhook: hookData.isWebhook ?? false,
            isSystem: hookData.isSystem ?? false,
          };
          hookEntityWriteOptions = writeHookEntityWithOverwrite
            ? { overwrite: true }
            : undefined;

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

        const compositeKey = `${effectiveRunId}-${eventId}`;
        const eventPath = taggedPath(basedir, 'events', compositeKey, tag);
        // Capture the serialized payload before the write's `await` so the
        // cached snapshot can't observe a later mutation (see
        // rememberStoredEvent).
        const serializedEvent = JSON.stringify(event, jsonReplacer, 2);
        const eventPublished = await writeExclusive(eventPath, serializedEvent);
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
          });
          events = allEvents.data;
          cursor = allEvents.cursor;
          hasMore = allEvents.hasMore;
        }

        // Inline-delta optimization: on a step-terminal write the inline
        // runtime loop can pass `sinceCursor` (the cursor from before it
        // began writing this step's events). We return the delta of
        // events written strictly after that cursor — exactly what an
        // `events.list({ cursor: sinceCursor, sortOrder: 'asc' })` would
        // return right now — so the loop can skip a redundant round-trip.
        //
        // This is computed against the same on-disk log the list path
        // reads, so it captures everything the fetch would: this step's
        // step_created/step_started/step_completed, any attr_set the step
        // body wrote, and any in-band events (e.g. hook_received,
        // wait_completed) another writer appended since the cursor. That
        // equivalence is what makes skipping the fetch safe — a missed
        // in-band event cannot diverge replay because the delta is the
        // fetch.
        //
        // Only step-terminal events qualify: step_created/step_started are
        // not loop boundaries (the loop fetches after step_completed /
        // step_failed), and run-terminal events end the loop. `resolveData`
        // matches the list path so eventData refs are handled identically.
        if (
          (data.eventType === 'step_completed' ||
            data.eventType === 'step_failed') &&
          typeof params?.sinceCursor === 'string'
        ) {
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
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = await paginatedFileSystemQuery({
        directory: path.join(basedir, 'events'),
        schema: EventSchema,
        cachedItems: eventCache,
        // No filePrefix - search all events
        filter: (event) => event.correlationId === correlationId,
        // Events in chronological order (oldest first) by default,
        // different from the default for other list calls.
        sortOrder: params.pagination?.sortOrder ?? 'asc',
        limit: params.pagination?.limit,
        cursor: params.pagination?.cursor,
        getCreatedAt: getObjectCreatedAt('evnt'),
        getId: (event) => event.eventId,
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
}
