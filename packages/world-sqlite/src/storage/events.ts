import {
  EntityConflictError,
  HookForceClaimedError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  AnyEventRequest,
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  EventsResolveData,
  Hook,
  HookCreatedEventRequest,
  PaginatedResponse,
  SerializedData,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import {
  applyAttributeChanges,
  entityResolveData,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  getMaxEventsPerRun,
  isChildEntityCreationEvent,
  isHookEventRequiringExistence,
  isLegacySpecVersion,
  isSlotEventId,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  slotToEventId,
  stripEventDataRefs,
  validateAttributeChanges,
  validateUlidTimestamp,
} from '@workflow/world';
import { encode, toMillis } from '../db.js';
import {
  assertSafeEntityId,
  type Ctx,
  claimLock,
  createTimeCursor,
  DEFAULT_RESOLVE_DATA_OPTION,
  deleteHookRow,
  type HookTokenClaim,
  hookDisposeLockName,
  insertRun,
  isHookDisposalCommitted,
  monotonicUlid,
  parseEvent,
  parseTimeCursor,
  readHook,
  readHookDisposeLock,
  readHookTokenClaim,
  readRun,
  readStep,
  readWait,
  releaseHookTokenClaimIfOwnedBy,
  SORT_KEY_CURSOR_PREFIX,
  signalRunTerminal,
  taggedLockName,
  writeHook,
  writeHookTokenClaim,
  writeRun,
  writeStep,
  writeWait,
} from './common.js';
import { filterRunData } from './filters.js';
import {
  deleteAllHooksForRun,
  purgeRunEntityData,
  purgesUserDataOnFinish,
  withRunPayloadsPurged,
} from './lifecycle.js';

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

interface ResumeClaim {
  runId: string;
  resumeId: string;
  hookId: string;
  eventId: string;
  payloadDigest?: string;
}

function isResumeEvent(event: Event, claim: ResumeClaim): boolean {
  return (
    event.eventType === 'hook_received' &&
    event.correlationId === claim.hookId &&
    (event.resumeId === undefined || event.resumeId === claim.resumeId)
  );
}

interface EventPagination {
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

export interface EventsStorageDeps {
  /** Tombstones and drops a run's stream chunks (zero-retention purge). */
  purgeRunStreams(runId: string): void;
}

export function createEventsStorage(
  ctx: Ctx,
  deps: EventsStorageDeps
): Storage['events'] {
  const { db } = ctx;
  const hookRetentionLimitMs = getHookRetentionLimitMs();

  // -------------------------------------------------------------------------
  // Event rows
  // -------------------------------------------------------------------------

  function readEventById(runId: string, eventId: string): Event | null {
    const row = db.get<{ data: Uint8Array }>(
      'SELECT data FROM events WHERE run_id = ? AND event_id = ? AND tag IN (?, ?)',
      runId,
      eventId,
      ctx.tag,
      ''
    );
    return row ? parseEvent(row.data) : null;
  }

  function lastSeq(runId: string): number {
    const row = db.get<{ seq: number | null }>(
      'SELECT max(seq) AS seq FROM events WHERE run_id = ?',
      runId
    );
    return row?.seq == null ? FIRST_EVENT_SLOT - 1 : Number(row.seq);
  }

  /**
   * True for a run whose log is ULID-numbered (written before slot ids):
   * it keeps minting ULIDs so one log never mixes the two schemes.
   */
  function isUlidNumberedRun(runId: string): boolean {
    const row = db.get<{ event_id: string }>(
      'SELECT event_id FROM events WHERE run_id = ? ORDER BY seq LIMIT 1',
      runId
    );
    return row !== undefined && !isSlotEventId(row.event_id);
  }

  /**
   * The id the next event published to `runId` will get. Valid until the
   * next publish to that run; everything runs inside one transaction, so no
   * other writer can take it in between.
   */
  function mintEventId(runId: string): string {
    if (isUlidNumberedRun(runId)) return `evnt_${monotonicUlid()}`;
    return slotToEventId(lastSeq(runId) + 1);
  }

  /**
   * Appends `event` to its run's log at the next position. A slot-numbered
   * event takes the slot of that position, so the id always names where the
   * event actually landed.
   */
  function storeEvent(event: Event): Event {
    const seq = lastSeq(event.runId) + 1;
    const stored: Event =
      eventIdToSlot(event.eventId) === null
        ? event
        : ({ ...event, eventId: slotToEventId(seq) } as Event);
    try {
      db.run(
        `INSERT INTO events
           (run_id, seq, event_id, tag, event_type, correlation_id, resume_id, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        stored.runId,
        seq,
        stored.eventId,
        ctx.tag,
        stored.eventType,
        (stored as { correlationId?: string }).correlationId ?? null,
        stored.resumeId ?? null,
        toMillis(stored.createdAt),
        encode(stored)
      );
    } catch (error) {
      if (
        String((error as Error).message).includes('UNIQUE constraint failed')
      ) {
        throw new EntityConflictError(
          `Event "${stored.eventId}" already exists for run "${stored.runId}"`
        );
      }
      throw error;
    }
    return stored;
  }

  function seqOfEvent(runId: string, eventId: string): number | null {
    const row = db.get<{ seq: number }>(
      'SELECT seq FROM events WHERE run_id = ? AND event_id = ?',
      runId,
      eventId
    );
    return row ? Number(row.seq) : null;
  }

  function cursorFor(event: Event): string {
    return isSlotEventId(event.eventId)
      ? `${SORT_KEY_CURSOR_PREFIX}${event.eventId}`
      : createTimeCursor(event.createdAt, event.eventId);
  }

  /**
   * One page of a run's log in replay order (`seq`), with world-local's
   * cursor format: `key:<eventId>` for slot ids, `<ISO>|<eventId>` for ULIDs.
   */
  function queryRunEvents(
    runId: string,
    pagination: EventPagination,
    correlationId?: string
  ): PaginatedResponse<Event> {
    const sortOrder = pagination.sortOrder ?? 'asc';
    const limit = pagination.limit ?? 20;
    const where: string[] = ['run_id = ?'];
    const params: (string | number)[] = [runId];
    if (correlationId !== undefined) {
      where.push('correlation_id = ?');
      params.push(correlationId);
    }
    const cursor = pagination.cursor;
    if (cursor) {
      let boundSeq: number | null = null;
      if (cursor.startsWith(SORT_KEY_CURSOR_PREFIX)) {
        const key = cursor.slice(SORT_KEY_CURSOR_PREFIX.length);
        boundSeq = seqOfEvent(runId, key) ?? eventIdToSlot(key);
      } else {
        const parsed = parseTimeCursor(cursor);
        if (parsed?.id) boundSeq = seqOfEvent(runId, parsed.id);
        if (boundSeq === null && parsed) {
          where.push(
            sortOrder === 'desc' ? 'created_at < ?' : 'created_at > ?'
          );
          params.push(parsed.timestamp.getTime());
        }
      }
      if (boundSeq !== null) {
        where.push(sortOrder === 'desc' ? 'seq < ?' : 'seq > ?');
        params.push(boundSeq);
      }
    }
    const rows = db.all<{ data: Uint8Array }>(
      `SELECT data FROM events WHERE ${where.join(' AND ')}
       ORDER BY seq ${sortOrder === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
      ...params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => parseEvent(row.data));
    const last = data.at(-1);
    return { data, cursor: last ? cursorFor(last) : null, hasMore };
  }

  // -------------------------------------------------------------------------
  // Hook helpers
  // -------------------------------------------------------------------------

  function refuseDisposedHookDelivery(hookId: string, token: unknown): void {
    const lock = readHookDisposeLock(ctx, hookId);
    if (!lock.committed) return;
    if (lock.forceClaimedBy) {
      throw new HookForceClaimedError(
        typeof token === 'string' ? token : '',
        lock.forceClaimedBy.runId,
        lock.forceClaimedBy.hookId
      );
    }
    throw new HookNotFoundError(hookId);
  }

  function isHookTokenClaimReleasable(claim: HookTokenClaim): boolean {
    if (claim.hookId && isHookDisposalCommitted(ctx, claim.hookId)) {
      return true;
    }
    const owningRun = readRun(ctx, claim.runId);
    if (!owningRun) return true;
    if (!isTerminalWorkflowRunStatus(owningRun.status)) return false;
    return (
      !claim.tokenRetentionUntil ||
      new Date(claim.tokenRetentionUntil).getTime() <= Date.now()
    );
  }

  function readResumeClaim(
    runId: string,
    resumeId: string
  ): ResumeClaim | null {
    const row = db.get<{
      hook_id: string;
      event_id: string;
      payload_digest: string | null;
    }>(
      'SELECT hook_id, event_id, payload_digest FROM hook_resumes WHERE run_id = ? AND resume_id = ?',
      runId,
      resumeId
    );
    if (!row) return null;
    return {
      runId,
      resumeId,
      hookId: row.hook_id,
      eventId: row.event_id,
      ...(row.payload_digest ? { payloadDigest: row.payload_digest } : {}),
    };
  }

  function writeResumeClaim(claim: ResumeClaim): void {
    db.run(
      `INSERT INTO hook_resumes (run_id, resume_id, hook_id, event_id, payload_digest)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, resume_id) DO UPDATE SET
         hook_id = excluded.hook_id, event_id = excluded.event_id,
         payload_digest = excluded.payload_digest`,
      claim.runId,
      claim.resumeId,
      claim.hookId,
      claim.eventId,
      claim.payloadDigest ?? null
    );
  }

  function findCommittedResumeEvent(claim: ResumeClaim): Event | null {
    const atClaimedId = readEventById(claim.runId, claim.eventId);
    if (atClaimedId && isResumeEvent(atClaimedId, claim)) return atClaimedId;
    const rows = db.all<{ data: Uint8Array }>(
      'SELECT data FROM events WHERE run_id = ? AND resume_id = ? ORDER BY seq',
      claim.runId,
      claim.resumeId
    );
    for (const row of rows) {
      const event = parseEvent(row.data);
      if (event.resumeId === claim.resumeId && isResumeEvent(event, claim)) {
        return event;
      }
    }
    return null;
  }

  function findExistingHookCreatedEventId(
    runId: string,
    hookId: string
  ): string | null {
    const row = db.get<{ event_id: string }>(
      `SELECT event_id FROM events
       WHERE run_id = ? AND correlation_id = ? AND event_type = 'hook_created'
       ORDER BY seq LIMIT 1`,
      runId,
      hookId
    );
    return row?.event_id ?? null;
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  /**
   * Writes a lifecycle-driven run update. Inside the transaction the run row
   * read at the top of `create` is already the freshest one, so attribute
   * writes can't be lost; the purge decision is made on those attributes.
   */
  function writeLifecycleRun<T extends WorkflowRun>(
    runId: string,
    proposed: T,
    afterCommit: (() => void)[]
  ): { run: T; purged: boolean } {
    const fresh = readRun(ctx, runId);
    const attributes = fresh?.attributes ?? proposed.attributes;
    let next: T = { ...proposed, attributes };
    const purged =
      isTerminalWorkflowRunStatus(next.status) &&
      purgesUserDataOnFinish(attributes);
    if (purged) {
      next = withRunPayloadsPurged(next, new Date());
    }
    writeRun(ctx, next);
    if (isTerminalWorkflowRunStatus(next.status)) {
      afterCommit.push(() => signalRunTerminal(runId));
    }
    return { run: next, purged };
  }

  function closeRunChildren(runId: string): void {
    deleteAllHooksForRun(ctx, runId);
    db.run('DELETE FROM waits WHERE run_id = ?', runId);
  }

  function handleLegacyEvent(
    runId: string,
    data: any,
    currentRun: WorkflowRun,
    resolveData: 'none' | 'all',
    afterCommit: (() => void)[]
  ): EventResult {
    switch (data.eventType) {
      case 'run_cancelled': {
        const now = new Date();
        const run: WorkflowRun = {
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
        };
        const purged = purgesUserDataOnFinish(run.attributes);
        const stored = purged ? withRunPayloadsPurged(run, now) : run;
        writeRun({ ...ctx, tag: '' }, stored);
        afterCommit.push(() => signalRunTerminal(runId));
        deleteAllHooksForRun(ctx, runId);
        if (purged) {
          purgeRunEntityData(ctx, runId);
          deps.purgeRunStreams(runId);
        }
        return {
          event: undefined,
          run: filterRunData(stored, resolveData) as WorkflowRun,
        };
      }
      case 'wait_completed':
      case 'hook_received': {
        const event: Event = {
          ...data,
          runId,
          eventId: `evnt_${monotonicUlid()}`,
          createdAt: new Date(),
          specVersion: SPEC_VERSION_CURRENT,
        };
        if (
          data.eventType === 'hook_received' &&
          isTerminalWorkflowRunStatus(currentRun.status)
        ) {
          throw new RunExpiredError(
            `Workflow run "${runId}" is already in a terminal state`
          );
        }
        storeEvent(event);
        return { event: stripEventDataRefs(event, resolveData) };
      }
      default:
        throw new Error(
          `Event type '${data.eventType}' not supported for legacy runs ` +
            `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
            `Please upgrade 'workflow' package.`
        );
    }
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  function createSync(
    runId: string | null,
    data: AnyEventRequest,
    params: CreateEventParams | undefined,
    afterCommit: (() => void)[]
  ): EventResult {
    const now = new Date();

    let effectiveRunId: string;
    if (data.eventType === 'run_created' && (!runId || runId === '')) {
      effectiveRunId = `wrun_${monotonicUlid()}`;
    } else if (!runId) {
      throw new Error('runId is required for non-run_created events');
    } else {
      effectiveRunId = runId;
    }

    if (data.eventType === 'run_created' && runId && runId !== '') {
      const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
      if (validationError) {
        throw new WorkflowWorldError(validationError);
      }
    }

    const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

    let currentRun: WorkflowRun | null = null;
    const skipRunValidationEvents = ['step_completed', 'step_retrying'];
    if (
      data.eventType !== 'run_created' &&
      !skipRunValidationEvents.includes(data.eventType)
    ) {
      currentRun = readRun(ctx, effectiveRunId);

      // Resilient start: run_started carrying the run's creation data
      // creates the run (and a synthetic run_created) when run_created never
      // landed.
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
          dynamicWorkflowCode?: SerializedData;
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
            encryptionPublicKey: runInputData.encryptionPublicKey,
            dynamicWorkflowCode: runInputData.dynamicWorkflowCode,
            createdAt: now,
            updatedAt: now,
          };
          if (insertRun(ctx, createdRun)) {
            storeEvent({
              eventType: 'run_created',
              runId: effectiveRunId,
              eventId: mintEventId(effectiveRunId),
              createdAt: now,
              specVersion: effectiveSpecVersion,
              eventData: {
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
                attributes: runInputData.attributes,
                allowReservedAttributes: runInputData.allowReservedAttributes,
                encryptionPublicKey: runInputData.encryptionPublicKey,
              },
            } as Event);
            currentRun = createdRun;
          } else {
            currentRun = readRun(ctx, effectiveRunId);
          }
        }
      }
    }

    let eventId = mintEventId(effectiveRunId);

    if (
      !currentRun &&
      (data.eventType === 'run_failed' ||
        data.eventType === 'attr_set' ||
        data.eventType === 'run_started')
    ) {
      throw new WorkflowRunNotFoundError(effectiveRunId);
    }

    if (currentRun) {
      if (requiresNewerWorld(currentRun.specVersion)) {
        throw new RunNotSupportedError(
          currentRun.specVersion!,
          SPEC_VERSION_CURRENT
        );
      }
      if (isLegacySpecVersion(currentRun.specVersion)) {
        return handleLegacyEvent(
          effectiveRunId,
          data,
          currentRun,
          entityResolveData(params?.resolveData) ?? DEFAULT_RESOLVE_DATA_OPTION,
          afterCommit
        );
      }
    }

    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart =
      createsChildEntity && data.eventType === 'step_started';

    if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
      // Idempotent cancel of an already-cancelled run.
      if (
        data.eventType === 'run_cancelled' &&
        currentRun.status === 'cancelled'
      ) {
        const stored = storeEvent({
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        } as Event);
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        return {
          event: stripEventDataRefs(stored, resolveData),
          run: currentRun,
          maxEvents: getMaxEventsPerRun(),
        };
      }
      if (data.eventType === 'run_started') {
        throw new RunExpiredError(
          `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`
        );
      }
      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${currentRun.status}"`
        );
      }
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

    // Step ordering and terminal-state validation.
    let validatedStep: Step | null = null;
    const stepEventRequiresExistingStep =
      isStepEventType(data.eventType) && data.eventType !== 'step_created';
    if (stepEventRequiresExistingStep && data.correlationId) {
      validatedStep = readStep(ctx, effectiveRunId, data.correlationId);
      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`);
      }
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
        if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
          if (
            validatedStep.status !== 'running' ||
            data.eventType === 'step_started'
          ) {
            throw new RunExpiredError(
              `Cannot ${data.eventType === 'step_started' ? 'start' : 'modify non-running'} step on run in terminal state "${currentRun.status}"`
            );
          }
        }
      }
    }

    // Hook existence, disposal and resume dedup.
    let resumeClaimRecordedId: string | null = null;
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
      if (data.eventType === 'hook_received' && params?.resumeId) {
        const committedClaim = readResumeClaim(effectiveRunId, params.resumeId);
        if (
          committedClaim &&
          committedClaim.hookId === data.correlationId &&
          (!params.resumePayloadDigest ||
            !committedClaim.payloadDigest ||
            committedClaim.payloadDigest === params.resumePayloadDigest)
        ) {
          const committedEvent = findCommittedResumeEvent(committedClaim);
          if (committedEvent) {
            return { event: committedEvent };
          }
        }
      }
      if (data.eventType === 'hook_received') {
        refuseDisposedHookDelivery(
          data.correlationId,
          (data.eventData as { token?: unknown } | undefined)?.token
        );
      }
      const existingHook = readHook(ctx, data.correlationId);
      if (!existingHook) {
        throw new HookNotFoundError(data.correlationId);
      }
      if (data.eventType === 'hook_received' && params?.resumeId) {
        const existingClaim = readResumeClaim(effectiveRunId, params.resumeId);
        if (existingClaim) {
          if (existingClaim.hookId !== data.correlationId) {
            throw new EntityConflictError(
              `hook_received resumeId "${params.resumeId}" already recorded for a different hook`
            );
          }
          if (
            params.resumePayloadDigest &&
            existingClaim.payloadDigest &&
            existingClaim.payloadDigest !== params.resumePayloadDigest
          ) {
            throw new EntityConflictError(
              `hook_received resumeId "${params.resumeId}" already recorded with a different payload`
            );
          }
          const committed = findCommittedResumeEvent(existingClaim);
          if (committed) {
            return { event: committed };
          }
        }
        resumeClaimRecordedId = eventId;
      }
    }

    let event: Event = {
      ...data,
      runId: effectiveRunId,
      eventId,
      createdAt: now,
      specVersion: effectiveSpecVersion,
      ...(data.eventType === 'hook_received' && params?.resumeId
        ? { resumeId: params.resumeId }
        : {}),
    } as Event;
    // run_started's creation data only seeds a resilient start; the event
    // itself doesn't carry it.
    if (data.eventType === 'run_started' && 'eventData' in event) {
      delete (event as any).eventData;
    }
    // The workflow code is stored once, on the run record.
    if (event.eventType === 'run_created' && event.eventData) {
      const {
        dynamicWorkflowCode: _dynamicWorkflowCode,
        dynamicWorkflowCodeRef: _dynamicWorkflowCodeRef,
        ...eventData
      } = event.eventData as any;
      event = { ...event, eventData } as Event;
    }
    // A lazy start's input lives on its synthetic step_created.
    if (
      lazyStepStart &&
      event.eventType === 'step_started' &&
      event.eventData
    ) {
      const { input: _strippedInput, ...eventData } = event.eventData as any;
      event = { ...event, eventData } as Event;
    }

    let run: WorkflowRun | undefined;
    let runPurged = false;
    let step: Step | undefined;
    let stepNeedsInputSeq = false;
    let hook: Hook | undefined;
    let wait: Wait | undefined;
    let stepCreatedLazily = false;
    let prePublishedEvent: Event | undefined;

    if (data.eventType === 'run_created' && 'eventData' in data) {
      const runData = data.eventData as {
        deploymentId: string;
        workflowName: string;
        input: SerializedData;
        executionContext?: Record<string, any>;
        attributes?: Record<string, string>;
        allowReservedAttributes?: true;
        encryptionPublicKey?: string;
        dynamicWorkflowCode?: SerializedData;
      };
      validateAttributeChanges(
        Object.entries(runData.attributes ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
        { allowReservedAttributes: runData.allowReservedAttributes === true }
      );
      run = {
        runId: effectiveRunId,
        deploymentId: runData.deploymentId,
        status: 'pending',
        workflowName: runData.workflowName,
        specVersion: effectiveSpecVersion,
        executionContext: runData.executionContext,
        input: runData.input,
        output: undefined,
        error: undefined,
        startedAt: undefined,
        completedAt: undefined,
        attributes: runData.attributes ?? {},
        encryptionPublicKey: runData.encryptionPublicKey,
        dynamicWorkflowCode: runData.dynamicWorkflowCode,
        createdAt: now,
        updatedAt: now,
      };
      if (!insertRun(ctx, run)) {
        throw new EntityConflictError(
          `Workflow run "${effectiveRunId}" already exists`
        );
      }
    } else if (data.eventType === 'run_started') {
      if (currentRun) {
        if (currentRun.status === 'running') {
          // Already running: a re-invocation. Hand back the log instead of
          // appending a duplicate run_started.
          if (params?.skipPreload) {
            return { run: currentRun, maxEvents: getMaxEventsPerRun() };
          }
          const preloaded = queryRunEvents(effectiveRunId, {
            limit: getMaxEventsPerRun(),
          });
          return {
            run: currentRun,
            events: preloaded.data,
            cursor: preloaded.cursor,
            hasMore: preloaded.hasMore,
            maxEvents: getMaxEventsPerRun(),
          };
        }
        const written = writeLifecycleRun(
          effectiveRunId,
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
            dynamicWorkflowCode: currentRun.dynamicWorkflowCode,
          } as WorkflowRun,
          afterCommit
        );
        run = written.run;
        runPurged = written.purged;
      }
    } else if (data.eventType === 'run_completed' && 'eventData' in data) {
      const completedData = data.eventData as { output?: any };
      if (currentRun) {
        const written = writeLifecycleRun(
          effectiveRunId,
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
            dynamicWorkflowCode: currentRun.dynamicWorkflowCode,
          } as WorkflowRun,
          afterCommit
        );
        run = written.run;
        runPurged = written.purged;
        closeRunChildren(effectiveRunId);
      }
    } else if (data.eventType === 'run_failed' && 'eventData' in data) {
      const failedData = data.eventData as {
        error: unknown;
        errorCode?: string;
      };
      if (currentRun) {
        const written = writeLifecycleRun(
          effectiveRunId,
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
            dynamicWorkflowCode: currentRun.dynamicWorkflowCode,
          } as WorkflowRun,
          afterCommit
        );
        run = written.run;
        runPurged = written.purged;
        closeRunChildren(effectiveRunId);
      }
    } else if (data.eventType === 'run_cancelled') {
      if (currentRun) {
        const written = writeLifecycleRun(
          effectiveRunId,
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
            dynamicWorkflowCode: currentRun.dynamicWorkflowCode,
          } as WorkflowRun,
          afterCommit
        );
        run = written.run;
        runPurged = written.purged;
        closeRunChildren(effectiveRunId);
      }
    } else if (data.eventType === 'attr_set' && currentRun) {
      const fresh = readRun(ctx, effectiveRunId);
      if (!fresh) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      validateAttributeChanges(data.eventData.changes, {
        existingKeys: Object.keys(fresh.attributes),
        allowReservedAttributes:
          data.eventData.allowReservedAttributes === true,
      });
      // A workflow-authored attribute write is replayed with the same
      // correlationId; the claim makes the replay a conflict, not a re-apply.
      if (data.correlationId && data.eventData.writer.type === 'workflow') {
        if (
          !claimLock(
            ctx,
            taggedLockName(
              `attributes/${effectiveRunId}-${data.correlationId}.created`,
              ctx.tag
            )
          )
        ) {
          throw new EntityConflictError(
            `Attribute event "${data.correlationId}" already exists`
          );
        }
      }
      run = {
        ...fresh,
        attributes: applyAttributeChanges(
          fresh.attributes,
          data.eventData.changes
        ),
        updatedAt: now,
      } as WorkflowRun;
      writeRun(ctx, run);
    } else if (data.eventType === 'step_created' && 'eventData' in data) {
      if (
        !claimLock(
          ctx,
          taggedLockName(
            `steps/${effectiveRunId}-${data.correlationId}.created`,
            ctx.tag
          )
        )
      ) {
        throw new EntityConflictError(
          `Step "${data.correlationId}" already created`
        );
      }
      const stepData = data.eventData as { stepName: string; input: any };
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
        specVersion: effectiveSpecVersion,
      };
      // Written after the event publishes, pointing at it for its input.
      stepNeedsInputSeq = true;
    } else if (data.eventType === 'step_started') {
      if (!validatedStep && lazyStepStart) {
        if (
          !claimLock(
            ctx,
            taggedLockName(
              `steps/${effectiveRunId}-${data.correlationId}.created`,
              ctx.tag
            )
          )
        ) {
          throw new EntityConflictError(
            `Step "${data.correlationId}" already created`
          );
        }
        const lazyData = data.eventData as { stepName: string; input: any };
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
        const stepCreated = storeEvent({
          eventType: 'step_created',
          runId: effectiveRunId,
          eventId: mintEventId(effectiveRunId),
          createdAt: now,
          specVersion: effectiveSpecVersion,
          correlationId: data.correlationId,
          eventData: { stepName: lazyData.stepName, input: lazyData.input },
        } as Event);
        writeStep(ctx, createdStep, eventIdSeq(stepCreated));
        validatedStep = createdStep;
        stepCreatedLazily = true;
        eventId = mintEventId(effectiveRunId);
        event = { ...event, eventId };
      }
      if (validatedStep) {
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
        step = {
          ...validatedStep,
          status: 'running',
          startedAt: validatedStep.startedAt ?? now,
          attempt: validatedStep.attempt + 1,
          retryAfter: undefined,
          updatedAt: now,
        };
        writeStep(ctx, step);
      }
    } else if (data.eventType === 'step_completed' && 'eventData' in data) {
      const completedData = data.eventData as { result: any };
      if (validatedStep) {
        claimStepTerminal(effectiveRunId, data.correlationId);
        step = {
          ...validatedStep,
          status: 'completed',
          output: completedData.result,
          completedAt: now,
          updatedAt: now,
        };
        writeStep(ctx, step);
      }
    } else if (data.eventType === 'step_failed' && 'eventData' in data) {
      const failedData = data.eventData as { error: unknown };
      if (validatedStep) {
        claimStepTerminal(effectiveRunId, data.correlationId);
        step = {
          ...validatedStep,
          status: 'failed',
          error: failedData.error as Uint8Array,
          completedAt: now,
          updatedAt: now,
        };
        writeStep(ctx, step);
      }
    } else if (data.eventType === 'step_retrying' && 'eventData' in data) {
      const retryData = data.eventData as { error: unknown; retryAfter?: Date };
      if (validatedStep) {
        step = {
          ...validatedStep,
          status: 'pending',
          error: retryData.error as Uint8Array,
          retryAfter: retryData.retryAfter,
          updatedAt: now,
        };
        writeStep(ctx, step);
      }
    } else if (data.eventType === 'hook_created' && 'eventData' in data) {
      const hookData = data.eventData as HookCreatedEventRequest['eventData'];
      let claimedFrom: NonNullable<HookTokenClaim['claimedFrom']> | undefined;
      type ClaimResult =
        | { status: 'claimed' }
        | { status: 'owned'; claim: HookTokenClaim }
        | {
            status: 'conflict';
            claim: HookTokenClaim;
            forceRefusedReason?: 'victim-spec-version';
          };

      const newClaim = (): HookTokenClaim => ({
        token: hookData.token,
        hookId: data.correlationId,
        runId: effectiveRunId,
        eventId,
        tokenRetentionUntil: hookData.tokenRetentionUntil,
        ...(claimedFrom && { claimedFrom }),
      });

      const claimResult = ((): ClaimResult => {
        const existingClaim = readHookTokenClaim(ctx, hookData.token);
        if (!existingClaim) {
          writeHookTokenClaim(ctx, newClaim());
          return { status: 'claimed' };
        }
        if (
          existingClaim.runId === effectiveRunId &&
          existingClaim.hookId === data.correlationId
        ) {
          return { status: 'owned', claim: existingClaim };
        }
        if (!isHookTokenClaimReleasable(existingClaim)) {
          if (hookData.force !== true || !existingClaim.hookId) {
            return { status: 'conflict', claim: existingClaim };
          }
          // Force claim: take the token from a live hook.
          const victimRun = readRun(ctx, existingClaim.runId);
          const victimRunning =
            victimRun !== null &&
            !isTerminalWorkflowRunStatus(victimRun.status);
          claimedFrom = {
            runId: existingClaim.runId,
            hookId: existingClaim.hookId,
            ...(victimRunning && {
              workflowName: victimRun.workflowName,
              deploymentId: victimRun.deploymentId,
              runSpecVersion: victimRun.specVersion,
            }),
          } as NonNullable<HookTokenClaim['claimedFrom']>;
          if (
            victimRunning &&
            (victimRun.specVersion ?? SPEC_VERSION_LEGACY) <
              SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
          ) {
            return {
              status: 'conflict',
              claim: existingClaim,
              forceRefusedReason: 'victim-spec-version',
            };
          }
          // Journal the claimer's hook_created before the victim is told,
          // so the takeover is recorded in the claimer's log first.
          const journaledEventId = findExistingHookCreatedEventId(
            effectiveRunId,
            data.correlationId
          );
          if (journaledEventId) {
            eventId = journaledEventId;
            prePublishedEvent = { ...event, eventId } as Event;
          } else {
            prePublishedEvent = storeEvent({
              ...event,
              eventData: {
                ...(event.eventData as Record<string, unknown>),
                forceClaimedFrom: claimedFrom,
              },
            } as Event);
            eventId = prePublishedEvent.eventId;
          }
          const lockWritten = claimLock(
            ctx,
            hookDisposeLockName(existingClaim.hookId, ctx.tag),
            JSON.stringify({
              forceClaimedBy: {
                runId: effectiveRunId,
                hookId: data.correlationId,
              },
            })
          );
          if (victimRunning && lockWritten) {
            storeEvent({
              eventType: 'hook_disposed',
              correlationId: existingClaim.hookId,
              eventData: {
                token: hookData.token,
                forceClaimedBy: {
                  runId: effectiveRunId,
                  hookId: data.correlationId,
                },
              },
              runId: existingClaim.runId,
              eventId: mintEventId(existingClaim.runId),
              createdAt: new Date(),
              specVersion: victimRun.specVersion,
            } as Event);
          }
        }
        // Release the previous owner's claim and hook, then claim.
        if (existingClaim.hookId) {
          deleteHookRow(ctx, existingClaim.hookId);
        }
        writeHookTokenClaim(ctx, newClaim());
        return { status: 'claimed' };
      })();

      if (claimResult.status === 'owned') {
        const existingClaim = claimResult.claim;
        if (existingClaim.claimedFrom) {
          claimedFrom = existingClaim.claimedFrom;
        }
        // This hook already holds the token: its hook_created is in the log.
        const canonicalEventId =
          existingClaim.eventId ||
          findExistingHookCreatedEventId(effectiveRunId, data.correlationId);
        if (
          canonicalEventId &&
          readEventById(effectiveRunId, canonicalEventId)
        ) {
          throw new EntityConflictError(
            `Event "${canonicalEventId}" already exists for run "${effectiveRunId}"`
          );
        }
        event = {
          ...data,
          eventData: {
            ...data.eventData,
            tokenRetentionUntil: existingClaim.tokenRetentionUntil,
          },
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        } as Event;
      }

      if (claimResult.status === 'conflict') {
        const existingClaim = claimResult.claim;
        const storedConflict = storeEvent({
          eventType: 'hook_conflict',
          correlationId: data.correlationId,
          eventData: {
            token: hookData.token,
            conflictingRunId: existingClaim.runId,
            ...(claimResult.forceRefusedReason !== undefined && {
              forceRefusedReason: claimResult.forceRefusedReason,
            }),
          },
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        } as Event);
        const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
        const conflictDelta =
          typeof params?.sinceCursor === 'string'
            ? queryRunEvents(effectiveRunId, {
                sortOrder: 'asc',
                cursor: params.sinceCursor,
              })
            : undefined;
        const conflictResult: EventResult = {
          event: stripEventDataRefs(storedConflict, resolveData),
          run,
          step,
          hook: undefined,
        };
        if (!conflictDelta) return conflictResult;
        return {
          ...conflictResult,
          events:
            resolveData === 'none'
              ? conflictDelta.data.map((delta) =>
                  stripEventDataRefs(delta, resolveData)
                )
              : conflictDelta.data,
          cursor: conflictDelta.cursor,
          hasMore: conflictDelta.hasMore,
        };
      }

      if (claimedFrom) {
        event = {
          ...event,
          eventData: {
            ...(event.eventData as Record<string, unknown>),
            forceClaimedFrom: claimedFrom,
          },
        } as Event;
      }
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
        createdAt: event.createdAt,
        specVersion: effectiveSpecVersion,
        isWebhook: persistedHookData.isWebhook ?? false,
        isSystem: persistedHookData.isSystem ?? false,
        tokenRetentionUntil: persistedHookData.tokenRetentionUntil,
        ...(claimedFrom && { claimedFrom }),
      } as Hook;
    } else if (data.eventType === 'hook_disposed') {
      if (!claimLock(ctx, hookDisposeLockName(data.correlationId, ctx.tag))) {
        throw new EntityConflictError(
          `Hook "${data.correlationId}" already disposed`
        );
      }
      const existingHook = readHook(ctx, data.correlationId);
      if (existingHook) {
        releaseHookTokenClaimIfOwnedBy(ctx, existingHook.token, existingHook);
      }
      deleteHookRow(ctx, data.correlationId);
    } else if (data.eventType === 'wait_created' && 'eventData' in data) {
      const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;
      if (
        !claimLock(
          ctx,
          taggedLockName(`waits/${waitCompositeKey}.created`, ctx.tag)
        )
      ) {
        throw new EntityConflictError(
          `Wait "${data.correlationId}" already exists`
        );
      }
      const waitData = data.eventData as { resumeAt?: Date };
      wait = {
        waitId: waitCompositeKey,
        runId: effectiveRunId,
        status: 'waiting',
        resumeAt: waitData.resumeAt,
        completedAt: undefined,
        createdAt: now,
        updatedAt: now,
        specVersion: effectiveSpecVersion,
      } as Wait;
      writeWait(ctx, wait);
    } else if (data.eventType === 'wait_completed') {
      const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;
      if (
        !claimLock(
          ctx,
          taggedLockName(`waits/${waitCompositeKey}.completed`, ctx.tag)
        )
      ) {
        throw new EntityConflictError(
          `Wait "${data.correlationId}" already completed`
        );
      }
      const existingWait = readWait(ctx, waitCompositeKey);
      if (!existingWait) {
        // Rolled back with the transaction, lock included.
        throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`);
      }
      wait = {
        ...existingWait,
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      } as Wait;
      writeWait(ctx, wait);
    }

    if (data.eventType === 'hook_received' && data.correlationId) {
      refuseDisposedHookDelivery(
        data.correlationId,
        (data.eventData as { token?: unknown } | undefined)?.token
      );
    }

    // A hook whose token was force-claimed before its creation was
    // journaled must not be journaled now.
    if (data.eventType === 'hook_created' && data.correlationId) {
      const own = readHookDisposeLock(ctx, data.correlationId);
      if (own.committed && own.forceClaimedBy) {
        throw new EntityConflictError(
          `Hook "${data.correlationId}" was force-claimed by another run before its creation was journaled`
        );
      }
    }

    // Publish.
    if (prePublishedEvent) {
      event = prePublishedEvent;
    } else {
      if (data.eventType === 'hook_received') {
        const runNow = readRun(ctx, effectiveRunId);
        if (runNow && isTerminalWorkflowRunStatus(runNow.status)) {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in a terminal state`
          );
        }
      }
      event = storeEvent(event);
      eventId = event.eventId;
    }

    if (
      data.eventType === 'hook_received' &&
      params?.resumeId &&
      resumeClaimRecordedId !== null
    ) {
      writeResumeClaim({
        runId: effectiveRunId,
        resumeId: params.resumeId,
        hookId: data.correlationId,
        eventId,
        ...(params.resumePayloadDigest
          ? { payloadDigest: params.resumePayloadDigest }
          : {}),
      });
    }

    if (step && stepNeedsInputSeq) {
      writeStep(ctx, step, eventIdSeq(event));
    }

    if (hook && data.eventType === 'hook_created') {
      writeHook(ctx, hook);
      // The claim names the event that journaled it.
      const claim = readHookTokenClaim(ctx, hook.token);
      if (
        claim &&
        claim.runId === hook.runId &&
        claim.hookId === hook.hookId &&
        claim.eventId !== eventId
      ) {
        writeHookTokenClaim(ctx, { ...claim, eventId });
      }
    }

    if (runPurged) {
      purgeRunEntityData(ctx, effectiveRunId);
      deps.purgeRunStreams(effectiveRunId);
    }

    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const filteredEvent = stripEventDataRefs(event, resolveData);

    let eventPage: PaginatedResponse<Event> | undefined;
    if (data.eventType === 'run_started' && run && !params?.skipPreload) {
      eventPage = queryRunEvents(effectiveRunId, {
        limit: getMaxEventsPerRun(),
      });
    }
    if (typeof params?.sinceCursor === 'string') {
      const delta = queryRunEvents(effectiveRunId, {
        sortOrder: 'asc',
        cursor: params.sinceCursor,
      });
      eventPage =
        resolveData === 'none'
          ? {
              ...delta,
              data: delta.data.map((e) => stripEventDataRefs(e, resolveData)),
            }
          : delta;
    }

    const result: EventResult = {
      event: filteredEvent,
      run,
      step,
      hook,
      wait,
      ...(stepCreatedLazily ? { stepCreated: true } : {}),
      ...(run ? { maxEvents: getMaxEventsPerRun() } : {}),
    };
    if (!eventPage) return result;
    return {
      ...result,
      events: eventPage.data,
      cursor: eventPage.cursor,
      hasMore: eventPage.hasMore,
    };
  }

  function eventIdSeq(event: Event): number {
    const seq = seqOfEvent(event.runId, event.eventId);
    if (seq === null) {
      throw new WorkflowWorldError(
        `Event "${event.eventId}" vanished from run "${event.runId}"`
      );
    }
    return seq;
  }

  function claimStepTerminal(runId: string, stepId: string): void {
    if (
      !claimLock(
        ctx,
        taggedLockName(`steps/${runId}-${stepId}.terminal`, ctx.tag)
      )
    ) {
      throw new EntityConflictError('Cannot modify step in terminal state');
    }
  }

  async function createOnce(
    runId: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> {
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
    if (runId != null && runId !== '') {
      assertSafeEntityId('runId', runId);
    }
    if ('correlationId' in data && typeof data.correlationId === 'string') {
      assertSafeEntityId('correlationId', data.correlationId);
    }
    const afterCommit: (() => void)[] = [];
    const result = db.transaction(() =>
      createSync(runId, data, params, afterCommit)
    );
    for (const fn of afterCommit) fn();
    return result;
  }

  /**
   * When the caller says how many events it has seen (`eventCount`) and the
   * new event landed further along, hand back the events in between so the
   * caller doesn't miss writes it raced with.
   */
  function reportSkippedSlots(
    result: EventResult,
    askedFor: number,
    resolveData: EventsResolveData
  ): EventResult {
    if (!result.event) return result;
    const committedSlot = eventIdToSlot(result.event.eventId);
    if (
      committedSlot === null ||
      askedFor < FIRST_EVENT_SLOT ||
      committedSlot <= askedFor + 1
    ) {
      return result;
    }
    const span = committedSlot - askedFor - 1;
    const page = list({
      runId: result.event.runId,
      pagination: {
        cursor: `${SORT_KEY_CURSOR_PREFIX}${slotToEventId(askedFor)}`,
        limit: span,
        sortOrder: 'asc',
      },
      resolveData,
    });
    const committedEventId = result.event.eventId;
    const events = page.data.filter((e) => e.eventId < committedEventId);
    return {
      ...result,
      events,
      cursor: null,
      hasMore: events.length < committedSlot - askedFor - 1,
    };
  }

  function list(params: Parameters<Storage['events']['list']>[0]) {
    const { runId } = params;
    assertSafeEntityId('runId', runId);
    const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const result = queryRunEvents(runId, {
      ...params.pagination,
      limit: params.pagination?.limit ?? getMaxEventsPerRun(),
    });
    if (resolveData === 'none') {
      return {
        ...result,
        data: result.data.map((e) => stripEventDataRefs(e, resolveData)),
      };
    }
    return result;
  }

  const create = (async (
    runId: string,
    data: CreateEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> => {
    if (params?.eventCount === undefined) {
      return createOnce(runId, data as AnyEventRequest, params);
    }
    const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const result = await createOnce(runId, data as AnyEventRequest, params);
    if (typeof params.sinceCursor === 'string') return result;
    return reportSkippedSlots(result, params.eventCount, resolveData);
  }) as Storage['events']['create'];

  return {
    create,

    async get(runId, eventId, params) {
      assertSafeEntityId('runId', runId);
      assertSafeEntityId('eventId', eventId);
      const event = readEventById(runId, eventId);
      if (!event) {
        throw new Error(`Event ${eventId} in run ${runId} not found`);
      }
      const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      return stripEventDataRefs(event, resolveData);
    },

    async list(params) {
      return list(params);
    },

    async listByCorrelationId(params) {
      const correlationId = params.correlationId;
      assertSafeEntityId('correlationId', correlationId);
      assertSafeEntityId('runId', params.runId);
      const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
      const result = queryRunEvents(
        params.runId,
        {
          sortOrder: params.pagination?.sortOrder ?? 'asc',
          limit: params.pagination?.limit,
          cursor: params.pagination?.cursor,
        },
        correlationId
      );
      if (resolveData === 'none') {
        return {
          ...result,
          data: result.data.map((e) => stripEventDataRefs(e, resolveData)),
        };
      }
      return result;
    },
  } as Storage['events'];
}
