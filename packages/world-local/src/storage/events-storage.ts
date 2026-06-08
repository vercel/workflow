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
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
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
  listJSONFiles,
  paginatedFileSystemQuery,
  readJSON,
  readJSONWithFallback,
  resolveWithinBase,
  taggedPath,
  writeExclusive,
  writeJSON,
} from '../fs.js';
import { stripEventDataRefs } from './filters.js';
import { getObjectCreatedAt, hashToken, monotonicUlid } from './helpers.js';
import { deleteAllHooksForRun } from './hooks-storage.js';
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
const stepLocks = new Map<string, Promise<unknown>>();

const HookTokenClaimSchema = z.object({
  runId: z.string(),
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

function withStepLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = stepLocks.get(key);
  const taskBox: { task?: Promise<T> } = {};
  const task = (async () => {
    if (prev) {
      // Wait for the previous task to settle; don't inherit its errors.
      await prev.catch(() => undefined);
    }
    try {
      return await fn();
    } finally {
      if (stepLocks.get(key) === taskBox.task) {
        stepLocks.delete(key);
      }
    }
  })();
  taskBox.task = task;
  stepLocks.set(key, task);
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
export function createEventsStorage(
  basedir: string,
  tag?: string
): Storage['events'] {
  return {
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
        return withStepLock(lockKey, () => createImpl());
      }
      return createImpl();

      async function createImpl(): Promise<EventResult> {
        const eventId = `evnt_${monotonicUlid()}`;
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

        // Helper to check if run is in terminal state
        const isRunTerminal = (status: string) =>
          ['completed', 'failed', 'cancelled'].includes(status);

        // Helper to check if step is in terminal state
        const isStepTerminal = (status: string) =>
          ['completed', 'failed', 'cancelled'].includes(status);

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
            };
            if (
              runInputData.deploymentId &&
              runInputData.workflowName &&
              runInputData.input !== undefined
            ) {
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
                attributes: {},
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
                  },
                };
                const createdCompositeKey = `${effectiveRunId}-${runCreatedEventId}`;
                await writeJSON(
                  taggedPath(basedir, 'events', createdCompositeKey, tag),
                  runCreatedEvent
                );
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

        // Run terminal state validation
        if (currentRun && isRunTerminal(currentRun.status)) {
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
            const compositeKey = `${effectiveRunId}-${eventId}`;
            await writeJSON(
              taggedPath(basedir, 'events', compositeKey, tag),
              event
            );
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

          // Creating new entities on terminal runs is not allowed
          if (
            data.eventType === 'step_created' ||
            data.eventType === 'hook_created' ||
            data.eventType === 'wait_created'
          ) {
            throw new EntityConflictError(
              `Cannot create new entities on run in terminal state "${currentRun.status}"`
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

          // Event ordering: step must exist before these events
          if (!validatedStep) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }

          // Step terminal state validation
          if (isStepTerminal(validatedStep.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${validatedStep.status}"`
            );
          }

          // On terminal runs: only allow completing/failing in-progress steps
          if (currentRun && isRunTerminal(currentRun.status)) {
            if (validatedStep.status !== 'running') {
              throw new RunExpiredError(
                `Cannot modify non-running step on run in terminal state "${currentRun.status}"`
              );
            }
          }
        }

        // Hook-related event validation (ordering)
        const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
        if (
          hookEventsRequiringExistence.includes(data.eventType) &&
          data.correlationId
        ) {
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
        const event: Event = {
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

        // Track entity created/updated for EventResult
        let run: WorkflowRun | undefined;
        let step: Step | undefined;
        let hook: Hook | undefined;
        let wait: Wait | undefined;

        // Create/update entity based on event type (event-sourced architecture)
        // Run lifecycle events
        if (data.eventType === 'run_created' && 'eventData' in data) {
          const runData = data.eventData as {
            deploymentId: string;
            workflowName: string;
            input: SerializedData;
            executionContext?: Record<string, any>;
          };
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
            attributes: {},
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
            if (freshStep && isStepTerminal(freshStep.status)) {
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
          const constraintPath = path.join(
            basedir,
            'hooks',
            'tokens',
            `${hashToken(hookData.token)}.json`
          );
          const tokenClaimed = await writeExclusive(
            constraintPath,
            JSON.stringify({
              token: hookData.token,
              hookId: data.correlationId,
              runId: effectiveRunId,
            })
          );

          if (!tokenClaimed) {
            const existingClaim = await readHookTokenClaim(constraintPath);

            // Create hook_conflict event instead of hook_created
            // This allows the workflow to continue and fail gracefully when the hook is awaited
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

            // Store the conflict event
            const compositeKey = `${effectiveRunId}-${eventId}`;
            await writeJSON(
              taggedPath(basedir, 'events', compositeKey, tag),
              conflictEvent
            );

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

          hook = {
            runId: effectiveRunId,
            hookId: data.correlationId,
            token: hookData.token,
            metadata: hookData.metadata,
            ownerId: 'local-owner',
            projectId: 'local-project',
            environment: 'local',
            createdAt: now,
            // Propagate specVersion from the event to the hook entity
            specVersion: effectiveSpecVersion,
            isWebhook: hookData.isWebhook ?? false,
            isSystem: hookData.isSystem ?? false,
          };
          await writeJSON(
            taggedPath(basedir, 'hooks', data.correlationId, tag),
            hook
          );
        } else if (data.eventType === 'hook_disposed') {
          // hook_disposed: Deletes hook entity, rejects duplicates.
          // Uses writeExclusive on a lock file to atomically prevent concurrent
          // invocations from both disposing the same hook (TOCTOU race).
          const hookLockName = tag
            ? `${data.correlationId}.disposed.${tag}`
            : `${data.correlationId}.disposed`;
          const lockPath = resolveWithinBase(
            basedir,
            '.locks',
            'hooks',
            hookLockName
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
            // Delete the token constraint file to free up the token for reuse
            const disposedConstraintPath = path.join(
              basedir,
              'hooks',
              'tokens',
              `${hashToken(existingHook.token)}.json`
            );
            await deleteJSON(disposedConstraintPath);
          }
          await deleteJSON(hookPath);
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

        // Store event using composite key {runId}-{eventId}
        const compositeKey = `${effectiveRunId}-${eventId}`;
        await writeJSON(
          taggedPath(basedir, 'events', compositeKey, tag),
          event
        );

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
