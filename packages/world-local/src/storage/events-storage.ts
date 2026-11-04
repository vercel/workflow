/**
 * `events.create` and the event-log reads.
 *
 * Every create is ONE SQLite transaction: it reads the entities it validates
 * against, appends its event(s) at the next position of the run's log, and
 * updates the run, step, wait and hook rows that follow from them. Either all
 * of it commits or none of it does, so the log and the entities never
 * disagree, a crash can never leave half a write behind, and two writers in
 * any processes are serialized by SQLite's write lock (see `db/index.ts`).
 *
 * The validation rules (which writes are refused, and with which error) are
 * the World contract the runtime is written against; they are unchanged from
 * the filesystem implementation this replaced.
 */

import { createHash } from 'node:crypto';
import {
  EntityConflictError,
  HookConflictError,
  HookForceClaimedError,
  HookNotFoundError,
  InBandSupersededError,
  RunExpiredError,
  RunNotSupportedError,
  START_HOOK_ADMISSION_REJECTED,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { debugLog } from '@workflow/utils';
import type {
  AnyEventRequest,
  CreateEventParams,
  Event,
  EventResult,
  EventsResolveData,
  Hook,
  HookCreatedEventRequest,
  PaginatedResponse,
  SerializedData,
  StartHook,
  StartHookRejectionReason,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import {
  applyAttributeChanges,
  getEventDataRefFields,
  getMaxEventsForRun,
  getMaxEventsPerRun,
  IN_BAND_SEQ_AT_RUN_CREATION,
  isChildEntityCreationEvent,
  isHookEventRequiringExistence,
  isStartHookId,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  slotToEventId,
  stripEventDataRefs,
  ulidToDate,
  validateAttributeChanges,
  validateUlidTimestamp,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { CommitThenThrow, type Database } from '../db/index.js';
import { assertSafeEntityId } from '../ids.js';
import { purgeRunData, purgesUserDataOnFinish } from './run-retention.js';
import { signalRunTerminal } from './run-status-signal.js';
import { startHookRecord, withStartHookId } from './start-hook.js';
import { eventCursor, type RunRow, Store } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const monotonicUlid = monotonicFactory();

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
 * A start Hook admission breadcrumb, under `DEBUG=workflow:*`. Names runs,
 * never the token: a token is the caller's idempotency key and may carry
 * user data.
 */
function startHookLog(message: string, detail: Record<string, string>): void {
  debugLog(`[world-local] start Hook: ${message}`, detail);
}

function startHookRejected(
  message: string,
  reason: StartHookRejectionReason
): WorkflowWorldError {
  return new WorkflowWorldError(message, {
    status: 400,
    code: START_HOOK_ADMISSION_REJECTED,
    reason,
  });
}

/** Thrown inside a create to commit what it wrote, then refuse. */
class RecordedRefusal extends Error {
  readonly refusal: unknown;
  constructor(refusal: unknown) {
    super('recorded refusal');
    this.refusal = refusal;
  }
}

type Resolve = EventsResolveData;

type RunCreationData = {
  deploymentId: string;
  workflowName: string;
  input: SerializedData;
  executionContext?: Record<string, any>;
  attributes?: Record<string, string>;
  allowReservedAttributes?: true;
  encryptionPublicKey?: string;
  dynamicWorkflowCode?: SerializedData;
  startHook?: StartHook;
};

export type LocalEventsStorage = Storage['events'] & {
  /** Nothing to clear: kept for callers of the filesystem implementation. */
  clearCache(): void;
};

export function createEventsStorage(
  db: Database,
  tag?: string
): LocalEventsStorage {
  const store = new Store(db, tag);
  const hookRetentionLimitMs = getHookRetentionLimitMs();

  // ------------------------------------------------------------------ hooks

  /**
   * Whether the token's current owner has let go of it: its hook was
   * disposed, its run no longer exists, or its run ended and the token's
   * retention is over.
   */
  function isTokenReleasable(owner: {
    hookId: string;
    runId: string;
    retentionUntil: number | null;
  }): boolean {
    if (store.getDisposal(owner.hookId)) return true;
    const ownerRun = store.getRunAnyTag(owner.runId);
    if (!ownerRun) return true;
    if (!isTerminalWorkflowRunStatus(ownerRun.run.status)) return false;
    return owner.retentionUntil === null || owner.retentionUntil <= Date.now();
  }

  /** Drops a released owner's token and its retained hook row. */
  function releaseOwner(token: string, owner: { hookId: string }): void {
    store.releaseToken(token, owner.hookId);
    const hook = store.getHook(owner.hookId);
    if (hook && hook.token === token) store.deleteHook(owner.hookId);
  }

  /**
   * A terminal run's hooks: each one whose token is still retained stays
   * (readable, refusing deliveries, holding its token) until the retention
   * ends; every other is deleted and its token released. Its waits go too.
   */
  function releaseRunResources(runId: string): void {
    const now = Date.now();
    for (const row of db.all<{ hook_id: string }>(
      'SELECT hook_id FROM hooks WHERE run_id = ?',
      runId
    )) {
      const hook = store.getHook(row.hook_id);
      if (!hook) continue;
      if (
        hook.tokenRetentionUntil &&
        new Date(hook.tokenRetentionUntil).getTime() > now
      ) {
        continue;
      }
      store.releaseToken(hook.token, hook.hookId);
      store.deleteHook(hook.hookId);
    }
    db.run('DELETE FROM waits WHERE run_id = ?', runId);
  }

  // ------------------------------------------------------------- start hook

  type Admission = { status: 'created' } | { status: 'existing'; run: RunRow };

  /**
   * Admits a `start({ hook })` candidate: in this transaction, the start
   * Hook's token is taken, and the run, its Hook and its `run_created` are
   * written; or the refusal is recorded (and committed) so every later
   * attempt for the candidate answers the same. See `start-hook.ts` in
   * `@workflow/world` for the contract.
   */
  function admitStartHook(
    runId: string,
    startHook: StartHook,
    writeRun: () => void
  ): Admission {
    const rejection = db.get<{ token: string; conflicting_run_id: string }>(
      'SELECT token, conflicting_run_id FROM start_hook_rejections WHERE run_id = ?',
      runId
    );
    if (rejection) {
      if (rejection.token !== startHook.token) {
        throw startHookRejected(
          `Workflow run "${runId}" was already decided for a different start Hook token`,
          'token_mismatch'
        );
      }
      throw new HookConflictError(
        rejection.token,
        rejection.conflicting_run_id
      );
    }
    const existing = store.getRun(runId);
    if (existing) {
      if (existing.run.startHook?.token !== startHook.token) {
        throw startHookRejected(
          `Workflow run "${runId}" already exists without this start Hook`,
          'ordinary_run'
        );
      }
      return { status: 'existing', run: existing };
    }
    const candidateTime = ulidToDate(runId.replace(/^wrun_/, ''));
    if (
      candidateTime &&
      Date.now() - candidateTime.getTime() > START_HOOK_CANDIDATE_MAX_AGE_MS
    ) {
      throw startHookRejected(
        `Workflow run "${runId}" is too old to be admitted with a start Hook`,
        'expired'
      );
    }
    const owner = store.getTokenOwner(startHook.token);
    if (owner) {
      if (!isTokenReleasable(owner)) {
        db.run(
          `INSERT INTO start_hook_rejections (run_id, tag, token, conflicting_run_id)
           VALUES (?, ?, ?, ?) ON CONFLICT (run_id) DO NOTHING`,
          runId,
          tag ?? null,
          startHook.token,
          owner.runId
        );
        startHookLog('refused a candidate', {
          runId,
          conflictingRunId: owner.runId,
        });
        throw new RecordedRefusal(
          new HookConflictError(startHook.token, owner.runId)
        );
      }
      startHookLog("released an ended owner's token to a candidate", {
        runId,
        previousRunId: owner.runId,
      });
      releaseOwner(startHook.token, owner);
    }
    writeRun();
    startHookLog('accepted a candidate', { runId });
    return { status: 'created' };
  }

  /** Writes an admitted start Hook's token and entity. */
  function writeStartHook(run: WorkflowRun): void {
    const hook = startHookRecord(run);
    if (!hook) return;
    store.setTokenOwner(
      hook.token,
      hook.hookId,
      run.runId,
      hook.tokenRetentionUntil
    );
    store.upsertHook(hook);
  }

  // --------------------------------------------------------------- results

  const resolveOf = (params?: CreateEventParams): Resolve =>
    params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;

  function page(
    runId: string,
    options: { cursor?: string; limit?: number },
    resolveData: Resolve
  ): { events: Event[]; cursor: string | null; hasMore: boolean } {
    const result = store.listEvents(runId, { ...options, sortOrder: 'asc' });
    return {
      events:
        resolveData === 'all'
          ? result.data
          : result.data.map((event) => stripEventDataRefs(event, resolveData)),
      cursor: result.cursor,
      hasMore: result.hasMore,
    };
  }

  // ---------------------------------------------------------------- create

  /** The body of one create, run inside its transaction. */
  function createInTransaction(
    runIdArg: string | null,
    data: AnyEventRequest,
    params: CreateEventParams | undefined,
    effects: Array<() => void>
  ): EventResult {
    const now =
      params?.inBand === true && params.occurredAt
        ? new Date(params.occurredAt)
        : new Date();

    let runId: string;
    if (data.eventType === 'run_created' && (!runIdArg || runIdArg === '')) {
      runId = `wrun_${monotonicUlid()}`;
    } else if (!runIdArg) {
      throw new Error('runId is required for non-run_created events');
    } else {
      runId = runIdArg;
    }

    if (data.eventType === 'run_created' && runIdArg) {
      const validationError = validateUlidTimestamp(runId, 'wrun_');
      if (validationError) {
        throw new WorkflowWorldError(validationError, {
          ...(data.eventData.startHook
            ? {
                status: 400,
                code: START_HOOK_ADMISSION_REJECTED,
                reason: 'expired',
              }
            : {}),
        });
      }
    }

    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const resolveData = resolveOf(params);

    // step_completed and step_retrying only act on a running step, which may
    // finish whatever its run's state: they are not validated against it.
    const skipsRunValidation =
      data.eventType === 'step_completed' || data.eventType === 'step_retrying';
    let current: RunRow | null =
      data.eventType === 'run_created' || skipsRunValidation
        ? null
        : store.getRun(runId);

    // ---- Resilient start --------------------------------------------------
    // A run_started carrying the run's creation data may arrive for a run
    // whose run_created never landed: start() enqueues before it writes, and
    // treats a retryable creation failure as recoverable. Create the run (and
    // its run_created) from the queued copy.
    let stepCreatedLazily = false;
    if (data.eventType === 'run_started' && !current && data.eventData) {
      const seed = data.eventData as Partial<RunCreationData>;
      if (seed.deploymentId && seed.workflowName && seed.input !== undefined) {
        validateAttributeChanges(
          Object.entries(seed.attributes ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
          { allowReservedAttributes: seed.allowReservedAttributes === true }
        );
        const created = buildRun(
          runId,
          seed as RunCreationData,
          specVersion,
          now
        );
        const writeRun = () => {
          store.insertRun(created);
          writeStartHook(created);
          store.appendEvent(
            runCreatedEvent(created, seed as RunCreationData, now)
          );
        };
        if (seed.startHook) {
          admitStartHook(runId, seed.startHook, writeRun);
        } else {
          writeRun();
        }
        current = store.getRun(runId);
      }
    }

    if (
      !current &&
      (data.eventType === 'run_failed' ||
        data.eventType === 'attr_set' ||
        data.eventType === 'run_started' ||
        data.eventType === 'run_cancelled')
    ) {
      throw new WorkflowRunNotFoundError(runId);
    }

    const run = current?.run ?? null;
    if (run && requiresNewerWorld(run.specVersion)) {
      throw new RunNotSupportedError(
        run.specVersion!,
        SPEC_VERSION_MAX_SUPPORTED
      );
    }

    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart =
      createsChildEntity && data.eventType === 'step_started';
    // A single-orchestrator run (spec >= 9) records an inline step's creation
    // on its step_started alone: no synthetic step_created, and the start
    // keeps its input.
    const creationOnStart = () =>
      lazyStepStart &&
      (run?.specVersion ?? 0) >= SPEC_VERSION_SINGLE_ORCHESTRATOR;

    // ---- Terminal run -----------------------------------------------------
    if (run && isTerminalWorkflowRunStatus(run.status)) {
      if (data.eventType === 'run_cancelled' && run.status === 'cancelled') {
        // Idempotent: cancelling a cancelled run records the request.
        const stored = store.appendEvent({
          ...data,
          runId,
          createdAt: now,
          specVersion,
        } as Event);
        return {
          event: stripEventDataRefs(stored, resolveData),
          run,
          maxEvents: getMaxEventsForRun(run),
        };
      }
      if (data.eventType === 'run_started') {
        throw new RunExpiredError(
          `Workflow run "${runId}" is already in terminal state "${run.status}"`
        );
      }
      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${run.status}"`
        );
      }
      if (createsChildEntity) {
        throw new EntityConflictError(
          `Cannot create new entities on run in terminal state "${run.status}"`
        );
      }
      if (data.eventType === 'attr_set') {
        throw new EntityConflictError(
          `Cannot set attributes on run in terminal state "${run.status}"`
        );
      }
    }

    // ---- Step ordering ----------------------------------------------------
    let validatedStep: Step | null = null;
    if (
      isStepEventType(data.eventType) &&
      data.eventType !== 'step_created' &&
      data.correlationId
    ) {
      validatedStep = store.getStep(runId, data.correlationId);
      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`);
      }
      // A lazy step_started is its step's exactly-once create claim: if the
      // step exists, another handler won and this one must not run the body.
      if (lazyStepStart && validatedStep) {
        throw new EntityConflictError(
          `Step "${data.correlationId}" already created`
        );
      }
      if (validatedStep) {
        if (isTerminalStepStatus(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`
          );
        }
        // On a terminal run only a running step may still finish; no step
        // may start, not even a redelivered start of one that reads running.
        if (run && isTerminalWorkflowRunStatus(run.status)) {
          if (
            validatedStep.status !== 'running' ||
            data.eventType === 'step_started'
          ) {
            throw new RunExpiredError(
              `Cannot ${data.eventType === 'step_started' ? 'start' : 'modify non-running'} step on run in terminal state "${run.status}"`
            );
          }
        }
      }
    }

    // ---- Hook existence ---------------------------------------------------
    let existingHook: Hook | null = null;
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
      const hookId = data.correlationId;
      if (data.eventType === 'hook_received' && params?.resumeId) {
        const committed = committedResume(runId, params.resumeId);
        if (committed) {
          if (committed.hookId !== hookId) {
            throw new EntityConflictError(
              `hook_received resumeId "${params.resumeId}" already recorded for a different hook`
            );
          }
          if (
            params.resumePayloadDigest &&
            committed.payloadDigest &&
            committed.payloadDigest !== params.resumePayloadDigest
          ) {
            throw new EntityConflictError(
              `hook_received resumeId "${params.resumeId}" already recorded with a different payload`
            );
          }
          // The resume was accepted once: answer with its event, whatever
          // happened to the hook since.
          return { event: stripEventDataRefs(committed.event, resolveData) };
        }
      }
      if (data.eventType === 'hook_received') {
        refuseDisposedHookDelivery(
          hookId,
          (data.eventData as { token?: unknown } | undefined)?.token
        );
      }
      existingHook = store.getHook(hookId);
      if (!existingHook || existingHook.runId !== runId) {
        throw new HookNotFoundError(hookId);
      }
      if (data.eventType === 'hook_received') {
        if (!run) throw new WorkflowRunNotFoundError(runId);
        if (isTerminalWorkflowRunStatus(run.status)) {
          throw new RunExpiredError(
            `Workflow run "${runId}" is already in a terminal state`
          );
        }
      }
    }

    // ---- The event --------------------------------------------------------
    let event = {
      ...data,
      runId,
      createdAt: now,
      specVersion,
      ...(data.eventType === 'hook_received' && params?.resumeId
        ? { resumeId: params.resumeId }
        : {}),
    } as Event;
    // run_started's eventData bootstraps the resilient path above; the
    // canonical copy lives on run_created.
    if (data.eventType === 'run_started' && 'eventData' in event) {
      delete (event as { eventData?: unknown }).eventData;
    }
    if (event.eventType === 'run_created' && event.eventData) {
      const {
        dynamicWorkflowCode: _code,
        dynamicWorkflowCodeRef: _ref,
        ...eventData
      } = event.eventData as Record<string, unknown>;
      if (eventData.startHook) {
        eventData.startHook = withStartHookId(
          eventData.startHook as StartHook,
          runId
        );
      }
      event = { ...event, eventData } as Event;
    }
    // A lazy step_started's input belongs on the synthetic step_created
    // (spec 8); stepName stays for replay's step-name check.
    if (
      lazyStepStart &&
      !creationOnStart() &&
      event.eventType === 'step_started' &&
      event.eventData
    ) {
      const { input: _input, ...eventData } = event.eventData as Record<
        string,
        unknown
      >;
      event = { ...event, eventData } as Event;
    }

    let resultRun: WorkflowRun | undefined;
    let step: Step | undefined;
    let hook: Hook | undefined;
    let wait: Wait | undefined;
    let runPurged = false;

    const lifecycle = (next: WorkflowRun): WorkflowRun => {
      const fresh = store.getRun(runId)?.run ?? next;
      let updated: WorkflowRun = { ...next, attributes: fresh.attributes };
      if (
        isTerminalWorkflowRunStatus(updated.status) &&
        purgesUserDataOnFinish(updated.attributes)
      ) {
        updated = withRunPayloadsPurged(updated, new Date());
        runPurged = true;
      }
      store.updateRun(updated);
      if (isTerminalWorkflowRunStatus(updated.status)) {
        effects.push(() => signalRunTerminal(runId));
      }
      return updated;
    };

    switch (data.eventType) {
      case 'run_created': {
        const runData = data.eventData as RunCreationData;
        validateAttributeChanges(
          Object.entries(runData.attributes ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
          { allowReservedAttributes: runData.allowReservedAttributes === true }
        );
        const created = buildRun(runId, runData, specVersion, now);
        if (runData.startHook) {
          let committedEvent: Event | undefined;
          const admission = admitStartHook(runId, runData.startHook, () => {
            store.insertRun(created);
            writeStartHook(created);
            committedEvent = store.appendEvent(event);
          });
          if (admission.status === 'existing') {
            const first = store.getEventAt(runId, 1);
            if (first?.eventType !== 'run_created') {
              throw new WorkflowWorldError(
                `Workflow run "${runId}" has no run_created at its first position`
              );
            }
            return {
              event: stripEventDataRefs(first, resolveData),
              run: admission.run.run,
              maxEvents: getMaxEventsForRun(admission.run.run),
            };
          }
          return finish(committedEvent!, created);
        }
        if (store.runExistsAnyTag(runId)) {
          throw new EntityConflictError(
            `Workflow run "${runId}" already exists`
          );
        }
        store.insertRun(created);
        resultRun = created;
        break;
      }

      case 'run_started': {
        if (run!.status === 'running') {
          // Idempotent: a concurrent invocation already started the run. No
          // second run_started is appended.
          if (params?.skipPreload) {
            return { run: run!, maxEvents: getMaxEventsForRun(run!) };
          }
          const preload = page(
            runId,
            { limit: getMaxEventsPerRun() },
            resolveData
          );
          return {
            run: run!,
            ...preload,
            maxEvents: getMaxEventsForRun(run!),
          };
        }
        resultRun = lifecycle({
          ...run!,
          status: 'running',
          output: undefined,
          error: undefined,
          completedAt: undefined,
          startedAt: run!.startedAt ?? now,
          updatedAt: now,
        });
        break;
      }

      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const terminalData = (data as { eventData?: Record<string, unknown> })
          .eventData;
        resultRun = lifecycle({
          ...run!,
          status:
            data.eventType === 'run_completed'
              ? 'completed'
              : data.eventType === 'run_failed'
                ? 'failed'
                : 'cancelled',
          output:
            data.eventType === 'run_completed'
              ? (terminalData?.output as SerializedData)
              : undefined,
          error:
            data.eventType === 'run_failed'
              ? (terminalData?.error as SerializedData)
              : undefined,
          ...(data.eventType === 'run_failed'
            ? { errorCode: terminalData?.errorCode as string | undefined }
            : {}),
          completedAt: now,
          updatedAt: now,
        } as WorkflowRun);
        releaseRunResources(runId);
        break;
      }

      case 'attr_set': {
        const fresh = store.getRun(runId)!.run;
        validateAttributeChanges(data.eventData.changes, {
          existingKeys: Object.keys(fresh.attributes ?? {}),
          allowReservedAttributes:
            data.eventData.allowReservedAttributes === true,
        });
        if (data.correlationId && data.eventData.writer.type === 'workflow') {
          if (store.findEvent(runId, data.correlationId, 'attr_set')) {
            throw new EntityConflictError(
              `Attribute event "${data.correlationId}" already exists`
            );
          }
        }
        resultRun = {
          ...fresh,
          attributes: applyAttributeChanges(
            fresh.attributes,
            data.eventData.changes
          ),
          updatedAt: now,
        };
        store.updateRun(resultRun);
        break;
      }

      case 'step_created': {
        if (store.getStep(runId, data.correlationId)) {
          throw new EntityConflictError(
            `Step "${data.correlationId}" already created`
          );
        }
        const stepData = data.eventData as { stepName: string; input: any };
        step = {
          runId,
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
          specVersion,
        };
        store.insertStep(step);
        break;
      }

      case 'step_started': {
        if (!validatedStep && lazyStepStart) {
          const lazyData = data.eventData as { stepName: string; input: any };
          validatedStep = {
            runId,
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
            specVersion,
          };
          store.insertStep(validatedStep);
          // The synthetic step_created replay relies on (spec 8), at the
          // position before this start.
          if (!creationOnStart()) {
            store.appendEvent({
              eventType: 'step_created',
              runId,
              createdAt: now,
              specVersion,
              correlationId: data.correlationId,
              eventData: {
                stepName: lazyData.stepName,
                input: lazyData.input,
              },
            } as Event);
          }
          stepCreatedLazily = true;
        }
        if (validatedStep) {
          if (
            validatedStep.retryAfter &&
            new Date(validatedStep.retryAfter).getTime() > Date.now()
          ) {
            throw new TooEarlyError(
              `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil(
                  (new Date(validatedStep.retryAfter).getTime() - Date.now()) /
                    1000
                ),
              }
            );
          }
          step = {
            ...validatedStep,
            status: 'running',
            startedAt: validatedStep.startedAt ?? now,
            attempt: validatedStep.attempt + 1,
            retryAfter: undefined,
            updatedAt: now,
          };
          store.updateStep(step);
        }
        break;
      }

      case 'step_completed': {
        if (validatedStep) {
          step = {
            ...validatedStep,
            status: 'completed',
            output: (data.eventData as { result: any }).result,
            completedAt: now,
            updatedAt: now,
          };
          store.updateStep(step);
        }
        break;
      }

      case 'step_failed': {
        if (validatedStep) {
          step = {
            ...validatedStep,
            status: 'failed',
            error: (data.eventData as { error: unknown }).error as Uint8Array,
            completedAt: now,
            updatedAt: now,
          };
          store.updateStep(step);
        }
        break;
      }

      case 'step_retrying': {
        if (validatedStep) {
          const retryData = data.eventData as {
            error: unknown;
            retryAfter?: Date;
          };
          step = {
            ...validatedStep,
            status: 'pending',
            error: retryData.error as Uint8Array,
            retryAfter: retryData.retryAfter,
            updatedAt: now,
          };
          store.updateStep(step);
        }
        break;
      }

      case 'hook_created': {
        const created = createHook(runId, run, data, event, params, now);
        if (created.kind === 'conflict') {
          const delta =
            typeof params?.sinceCursor === 'string'
              ? page(runId, { cursor: params.sinceCursor }, resolveData)
              : undefined;
          return {
            event: stripEventDataRefs(created.event, resolveData),
            run: undefined,
            step: undefined,
            hook: undefined,
            ...(delta ?? {}),
          } as EventResult;
        }
        event = created.event;
        hook = created.hook;
        break;
      }

      case 'hook_disposed': {
        if (!store.insertDisposal(data.correlationId, runId)) {
          throw new EntityConflictError(
            `Hook "${data.correlationId}" already disposed`
          );
        }
        if (existingHook) {
          store.releaseToken(existingHook.token, existingHook.hookId);
        }
        store.deleteHook(data.correlationId);
        break;
      }

      case 'wait_created': {
        if (store.getWait(runId, data.correlationId)) {
          throw new EntityConflictError(
            `Wait "${data.correlationId}" already exists`
          );
        }
        wait = {
          waitId: `${runId}-${data.correlationId}`,
          runId,
          status: 'waiting',
          resumeAt: (data.eventData as { resumeAt?: Date }).resumeAt,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
          specVersion,
        };
        store.insertWait(data.correlationId, wait);
        break;
      }

      case 'wait_completed': {
        const existingWait = store.getWait(runId, data.correlationId);
        if (!existingWait) {
          throw new WorkflowWorldError(
            `Wait "${data.correlationId}" not found`
          );
        }
        if (existingWait.status === 'completed') {
          throw new EntityConflictError(
            `Wait "${data.correlationId}" already completed`
          );
        }
        wait = {
          ...existingWait,
          status: 'completed',
          completedAt: now,
          updatedAt: now,
        };
        store.updateWait(data.correlationId, wait);
        break;
      }

      default:
        break;
    }

    const stored = store.appendEvent(event);

    if (data.eventType === 'hook_received' && params?.resumeId) {
      db.run(
        `INSERT INTO hook_resumes (run_id, resume_id, hook_id, seq, payload_digest)
         VALUES (?, ?, ?, ?, ?)`,
        runId,
        params.resumeId,
        data.correlationId,
        Number(stored.eventId.slice('evnt_'.length)),
        params.resumePayloadDigest ?? null
      );
    }

    if (runPurged) {
      purgeRunData(db, runId);
      // The scrubbed bytes are still in the WAL until it is checkpointed.
      effects.push(() => db.checkpoint());
    }

    return finish(stored, resultRun, { step, hook, wait, stepCreatedLazily });

    function finish(
      committed: Event,
      finalRun: WorkflowRun | undefined,
      extra: {
        step?: Step;
        hook?: Hook;
        wait?: Wait;
        stepCreatedLazily?: boolean;
      } = {}
    ): EventResult {
      let delta:
        | { events: Event[]; cursor: string | null; hasMore: boolean }
        | undefined;
      if (
        data.eventType === 'run_started' &&
        finalRun &&
        !params?.skipPreload
      ) {
        delta = page(runId, { limit: getMaxEventsPerRun() }, resolveData);
      }
      if (typeof params?.sinceCursor === 'string') {
        delta = page(runId, { cursor: params.sinceCursor }, resolveData);
      }
      const reportRun = finalRun;
      const result: EventResult = {
        event: stripEventDataRefs(committed, resolveData),
        run: reportRun,
        step: extra.step,
        hook: extra.hook,
        wait: extra.wait,
        ...(extra.stepCreatedLazily ? { stepCreated: true as const } : {}),
        ...(reportRun ? { maxEvents: getMaxEventsForRun(reportRun) } : {}),
      };
      return delta ? ({ ...result, ...delta } as EventResult) : result;
    }
  }

  function committedResume(
    runId: string,
    resumeId: string
  ): { hookId: string; payloadDigest: string | null; event: Event } | null {
    const row = db.get<{
      hook_id: string;
      seq: number;
      payload_digest: string | null;
    }>(
      'SELECT hook_id, seq, payload_digest FROM hook_resumes WHERE run_id = ? AND resume_id = ?',
      runId,
      resumeId
    );
    if (!row) return null;
    const event = store.getEventAt(runId, Number(row.seq));
    if (!event) return null;
    return { hookId: row.hook_id, payloadDigest: row.payload_digest, event };
  }

  /**
   * Refuses a `hook_received` to a disposed hook. A hook its run disposed
   * answers not found; one another run took over (`experimental_force`) is
   * a redirect naming the token's current owner, so `resumeHook()` follows
   * the token.
   */
  function refuseDisposedHookDelivery(hookId: string, token: unknown): void {
    const disposal = store.getDisposal(hookId);
    if (!disposal) return;
    if (disposal.forceClaimedBy) {
      const tokenString = typeof token === 'string' ? token : '';
      const successor = tokenString ? store.getTokenOwner(tokenString) : null;
      throw new HookForceClaimedError(
        tokenString,
        successor?.runId ?? disposal.forceClaimedBy.runId,
        successor?.hookId ?? disposal.forceClaimedBy.hookId
      );
    }
    throw new HookNotFoundError(hookId);
  }

  type HookCreation =
    | { kind: 'created'; event: Event; hook: Hook }
    | { kind: 'conflict'; event: Event };

  /**
   * `hook_created`: takes the hook's token, or records a `hook_conflict`
   * when another live hook holds it. A forced creation
   * (`createHook({ experimental_force: true })`) takes the token from its
   * holder in the same transaction: the holder's `hook_disposed`
   * (`forceClaimedBy`) lands in its own run's log, so a resume can never be
   * accepted for a hook that no longer holds its token.
   */
  function createHook(
    runId: string,
    run: WorkflowRun | null,
    data: Extract<AnyEventRequest, { eventType: 'hook_created' }>,
    event: Event,
    _params: CreateEventParams | undefined,
    now: Date
  ): HookCreation {
    const hookId = data.correlationId;
    const hookData = data.eventData as HookCreatedEventRequest['eventData'];
    const specVersion = event.specVersion;
    if (!run) throw new WorkflowRunNotFoundError(runId);
    if (
      store.getDisposal(hookId) ||
      store.findEvent(runId, hookId, 'hook_created')
    ) {
      throw new EntityConflictError(`Hook "${hookId}" already created`);
    }

    let claimedFrom:
      | {
          runId: string;
          hookId: string;
          workflowName?: string;
          deploymentId?: string;
          runSpecVersion?: number;
        }
      | undefined;
    const owner = store.getTokenOwner(hookData.token);
    if (owner) {
      if (owner.runId === runId && owner.hookId === hookId) {
        throw new EntityConflictError(`Hook "${hookId}" already created`);
      }
      if (!isTokenReleasable(owner)) {
        const conflict = (forceRefusedReason?: 'victim-spec-version') =>
          ({
            kind: 'conflict',
            event: store.appendEvent({
              eventType: 'hook_conflict',
              correlationId: hookId,
              eventData: {
                token: hookData.token,
                conflictingRunId: owner.runId,
                ...(forceRefusedReason !== undefined && { forceRefusedReason }),
              },
              runId,
              createdAt: now,
              specVersion,
            } as Event),
          }) as const;
        if (hookData.force !== true) return conflict();
        const victim = store.getRunAnyTag(owner.runId);
        const victimRunning =
          victim !== null && !isTerminalWorkflowRunStatus(victim.run.status);
        // A running victim on a runtime that cannot read a forced disposal
        // would wait on the hook forever: decline, and say so.
        if (
          victimRunning &&
          (victim.run.specVersion ?? SPEC_VERSION_LEGACY) <
            SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
        ) {
          return conflict('victim-spec-version');
        }
        claimedFrom = {
          runId: owner.runId,
          hookId: owner.hookId,
          ...(victimRunning && {
            workflowName: victim.run.workflowName,
            deploymentId: victim.run.deploymentId,
            runSpecVersion: victim.run.specVersion,
          }),
        };
        store.insertDisposal(owner.hookId, owner.runId, { runId, hookId });
        if (victimRunning) {
          store.appendEvent({
            eventType: 'hook_disposed',
            correlationId: owner.hookId,
            eventData: {
              token: hookData.token,
              forceClaimedBy: { runId, hookId },
            },
            runId: owner.runId,
            createdAt: new Date(),
            specVersion: victim.run.specVersion,
          } as Event);
        }
        store.deleteHook(owner.hookId);
      } else {
        releaseOwner(hookData.token, owner);
      }
    }

    const stored = claimedFrom
      ? ({
          ...event,
          eventData: {
            ...(event.eventData as Record<string, unknown>),
            forceClaimedFrom: claimedFrom,
          },
        } as Event)
      : event;
    const hook: Hook = {
      runId,
      hookId,
      token: hookData.token,
      metadata: hookData.metadata,
      ownerId: 'local-owner',
      projectId: 'local-project',
      environment: 'local',
      createdAt: now,
      specVersion,
      isWebhook: hookData.isWebhook ?? false,
      isSystem: hookData.isSystem ?? false,
      tokenRetentionUntil: hookData.tokenRetentionUntil,
      ...(claimedFrom && { claimedFrom }),
    };
    store.setTokenOwner(
      hookData.token,
      hookId,
      runId,
      hookData.tokenRetentionUntil
    );
    store.upsertHook(hook);
    return { kind: 'created', event: stored, hook };
  }

  /** Validation that needs no database. */
  function validateRequest(runId: string | null, data: AnyEventRequest): void {
    if (
      data.eventType === 'hook_created' &&
      data.eventData.tokenRetentionUntil !== undefined &&
      new Date(data.eventData.tokenRetentionUntil).getTime() >
        Date.now() + hookRetentionLimitMs
    ) {
      throw new WorkflowWorldError(
        `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Local World.`,
        { status: 400 }
      );
    }
    // A run's start Hook id is taken by its admission, which writes no
    // hook_created for it.
    if (
      data.eventType === 'hook_created' &&
      runId &&
      isStartHookId(runId, data.correlationId)
    ) {
      throw new WorkflowWorldError(
        `Hook id "${data.correlationId}" is the start Hook of workflow run "${runId}" and is created by its admission`,
        { status: 400 }
      );
    }
    const startHookRetention =
      data.eventType === 'run_created' || data.eventType === 'run_started'
        ? (data.eventData as { startHook?: StartHook } | undefined)?.startHook
            ?.tokenRetentionUntil
        : undefined;
    if (
      startHookRetention !== undefined &&
      new Date(startHookRetention).getTime() > Date.now() + hookRetentionLimitMs
    ) {
      throw startHookRejected(
        `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Local World.`,
        'invalid'
      );
    }
    if (runId != null && runId !== '') assertSafeEntityId('runId', runId);
    if ('correlationId' in data && typeof data.correlationId === 'string') {
      assertSafeEntityId('correlationId', data.correlationId);
    }
  }

  /** One create, fenced when it is an in-band write. */
  function create(
    runId: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams
  ): EventResult {
    validateRequest(runId, data);
    const fenced =
      params?.inBand === true && !!runId && data.eventType !== 'run_created';
    if (fenced) {
      const expected = params.expectedSeqInBand;
      if (
        expected === undefined ||
        !Number.isSafeInteger(expected) ||
        expected < 0
      ) {
        throw new WorkflowWorldError(
          `An in-band write to run ${runId} must carry a nonnegative integer expectedSeqInBand`,
          { status: 400 }
        );
      }
    }
    const effects: Array<() => void> = [];
    const result = db.transact(() => {
      try {
        if (fenced) {
          const current = store.getRun(runId!);
          const seqInBand = current?.seqInBand ?? IN_BAND_SEQ_AT_RUN_CREATION;
          if (seqInBand !== params!.expectedSeqInBand) {
            throw new InBandSupersededError(
              `In-band write on run ${runId} expected seqInBand ${params!.expectedSeqInBand}, but the run is at ${seqInBand}. Another orchestrator wrote in-band events this one has not seen; stop writing and redeliver.`,
              { seqInBand, seq: store.topSeq(runId!) }
            );
          }
        }
        const seqBefore = fenced ? store.topSeq(runId!) : 0;
        const created = createInTransaction(runId, data, params, effects);
        let result = created;
        if (fenced) {
          // One position per create that appended to this run's log. One that
          // appended nothing (run_started on a running run, a hook_received
          // converging on the event its resumeId already holds) moves nothing.
          const allocated = store.topSeq(runId!) > seqBefore ? 1 : 0;
          if (allocated > 0) store.advanceInBand(runId!);
          result = { ...created, allocated } as EventResult;
        }
        return withSkippedReport(result, params);
      } catch (error) {
        if (error instanceof RecordedRefusal) {
          return new CommitThenThrow(error.refusal) as never;
        }
        throw error;
      }
    });
    for (const effect of effects) effect();
    return result;
  }

  /**
   * The bump-and-report half of the slot contract: the events sitting
   * between the position the writer had read up to (`eventCount`) and the
   * one its write landed on.
   */
  function withSkippedReport(
    result: EventResult,
    params: CreateEventParams | undefined
  ): EventResult {
    if (
      params?.eventCount === undefined ||
      typeof params.sinceCursor === 'string' ||
      !result.event
    ) {
      return result;
    }
    const committedSlot = Number(result.event.eventId.slice('evnt_'.length));
    const askedFor = params.eventCount;
    if (
      !Number.isFinite(committedSlot) ||
      askedFor < 1 ||
      committedSlot <= askedFor + 1
    ) {
      return result;
    }
    const resolveData = resolveOf(params);
    const events = store
      .eventsBetween(result.event.runId, askedFor, committedSlot)
      .map((event) => stripEventDataRefs(event, resolveData));
    return {
      ...result,
      events,
      cursor: null,
      hasMore: events.length < committedSlot - askedFor - 1,
    } as EventResult;
  }

  return {
    async create(
      runId: string | null,
      data: AnyEventRequest,
      params?: CreateEventParams
    ) {
      return create(runId, data, params);
    },

    async get(runId, eventId, params) {
      assertSafeEntityId('runId', runId);
      assertSafeEntityId('eventId', eventId);
      const event = store.getEvent(runId, eventId);
      if (!event) {
        throw new Error(`Event ${eventId} in run ${runId} not found`);
      }
      return stripEventDataRefs(
        event,
        params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION
      );
    },

    async list(params) {
      assertSafeEntityId('runId', params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      // Read before the page: a load that follows its cursor to the end sees
      // every in-band write this count stands for.
      const runRow = db.get<{ seq: number; seq_in_band: number }>(
        'SELECT seq, seq_in_band FROM runs WHERE run_id = ?',
        params.runId
      );
      const snapshot = {
        seq: Number(runRow?.seq ?? 0),
        seqInBand: Number(runRow?.seq_in_band ?? IN_BAND_SEQ_AT_RUN_CREATION),
      };
      const result = store.listEvents(params.runId, {
        cursor: params.pagination?.cursor,
        limit: params.pagination?.limit ?? getMaxEventsPerRun(),
        sortOrder: params.pagination?.sortOrder ?? 'asc',
      });
      return {
        ...result,
        data:
          resolveData === 'all'
            ? result.data
            : result.data.map((event) =>
                stripEventDataRefs(event, resolveData)
              ),
        snapshot,
      };
    },

    async listByCorrelationId(params) {
      assertSafeEntityId('runId', params.runId);
      assertSafeEntityId('correlationId', params.correlationId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = store.listEvents(params.runId, {
        correlationId: params.correlationId,
        cursor: params.pagination?.cursor,
        limit: params.pagination?.limit,
        sortOrder: params.pagination?.sortOrder ?? 'asc',
      });
      return {
        ...result,
        data:
          resolveData === 'all'
            ? result.data
            : result.data.map((event) =>
                stripEventDataRefs(event, resolveData)
              ),
      } as PaginatedResponse<Event>;
    },

    clearCache() {},
  } as LocalEventsStorage;
}

/** The run a creation request describes. */
function buildRun(
  runId: string,
  data: RunCreationData,
  specVersion: number,
  now: Date
): WorkflowRun {
  return {
    runId,
    deploymentId: data.deploymentId,
    status: 'pending',
    workflowName: data.workflowName,
    specVersion,
    executionContext: data.executionContext,
    input: data.input,
    output: undefined,
    error: undefined,
    startedAt: undefined,
    completedAt: undefined,
    attributes: data.attributes ?? {},
    encryptionPublicKey: data.encryptionPublicKey,
    // A dynamic run's own code is stored on the run (what replay reads),
    // never on its creation event.
    dynamicWorkflowCode: data.dynamicWorkflowCode,
    ...(data.startHook
      ? { startHook: withStartHookId(data.startHook, runId) }
      : {}),
    createdAt: now,
    updatedAt: now,
  } as WorkflowRun;
}

/** The `run_created` a resilient start writes for the run it creates. */
function runCreatedEvent(
  run: WorkflowRun,
  data: RunCreationData,
  now: Date
): Event {
  return {
    eventType: 'run_created',
    runId: run.runId,
    createdAt: now,
    specVersion: run.specVersion,
    eventData: {
      deploymentId: data.deploymentId,
      workflowName: data.workflowName,
      input: data.input,
      executionContext: data.executionContext,
      attributes: data.attributes,
      allowReservedAttributes: data.allowReservedAttributes,
      encryptionPublicKey: data.encryptionPublicKey,
      ...(run.startHook ? { startHook: run.startHook } : {}),
    },
  } as Event;
}

/** A terminal run with `$retention: '0'`: its own payloads are gone. */
export function withRunPayloadsPurged<T extends WorkflowRun>(
  run: T,
  purgedAt: Date
): T {
  return {
    ...run,
    input: undefined,
    output: undefined,
    error: undefined,
    dynamicWorkflowCode: undefined,
    ...(run.startHook?.metadata !== undefined && {
      startHook: { ...run.startHook, metadata: undefined },
    }),
    expiredAt: purgedAt,
  };
}

/** A payload digest for `hook_received` deduplication (unused fields kept). */
export function payloadDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export { getEventDataRefFields, eventCursor, slotToEventId };
