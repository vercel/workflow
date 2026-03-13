import {
  HookNotFoundError,
  RunNotSupportedError,
  WorkflowAPIError,
} from '@workflow/errors';
import type {
  Event,
  EventResult,
  Hook,
  PaginatedResponse,
  ResolveData,
  Step,
  StepWithoutData,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  validateUlidTimestamp,
  WorkflowRunSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import {
  deleteHookIndex,
  deleteHooksForRunIndex,
  insertHookIndex,
  upsertRunIndex,
} from './d1.js';
import { toISOOrUndef } from './util.js';

const ulid = monotonicFactory();

// ============================================================
// Data filtering helpers (strip data for resolveData='none')
// ============================================================

function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = run;
    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}

function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest };
  }
  return hook;
}

function filterEventData(event: Event, resolveData: ResolveData): Event {
  if (resolveData === 'none' && 'eventData' in event) {
    const { eventData: _, ...rest } = event;
    return rest as Event;
  }
  return event;
}

// ============================================================
// DO storage key prefixes
// ============================================================
const KEY = {
  run: 'run',
  event: (id: string) => `evt:${id}`,
  step: (id: string) => `step:${id}`,
  hook: (id: string) => `hook:${id}`,
  hookToken: (token: string) => `hook_tok:${token}`,
  wait: (id: string) => `wait:${id}`,
  streamChunk: (streamId: string, chunkId: string) =>
    `strm:${streamId}:chnk:${chunkId}`,
  streamMeta: (streamId: string) => `strm:${streamId}:meta`,
  streamIndex: 'strm_idx',
} as const;

interface StreamChunkData {
  data: number[];
  eof: boolean;
}

// ============================================================
// WorkflowRunDO — one instance per workflow run
// ============================================================

interface Env {
  WORKFLOW_DB: D1Database;
}

export class WorkflowRunDO implements DurableObject {
  private storage: DurableObjectStorage;
  private db: D1Database;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.db = env.WORKFLOW_DB;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    try {
      // POST /events — create event
      if (method === 'POST' && path === '/events') {
        const body = (await request.json()) as {
          runId: string | null;
          data: any;
          params?: any;
        };
        const result = await this.createEvent(
          body.runId,
          body.data,
          body.params
        );
        return Response.json(result);
      }

      // GET /run — get run entity
      if (method === 'GET' && path === '/run') {
        const resolveData =
          (url.searchParams.get('resolveData') as ResolveData) ?? 'all';
        const run = await this.getRun(resolveData);
        return Response.json(run);
      }

      // GET /events — list events
      if (method === 'GET' && path === '/events') {
        const result = await this.listEvents({
          limit: parseInt(url.searchParams.get('limit') ?? '100', 10),
          cursor: url.searchParams.get('cursor') ?? undefined,
          sortOrder:
            (url.searchParams.get('sortOrder') as 'asc' | 'desc') ?? 'asc',
          resolveData:
            (url.searchParams.get('resolveData') as ResolveData) ?? 'all',
        });
        return Response.json(result);
      }

      // GET /events/:eventId — get single event
      if (method === 'GET' && path.startsWith('/events/')) {
        const eventId = path.slice('/events/'.length);
        const resolveData =
          (url.searchParams.get('resolveData') as ResolveData) ?? 'all';
        const event = await this.getEvent(eventId, resolveData);
        return Response.json(event);
      }

      // GET /events-by-correlation — list events by correlation ID
      if (method === 'GET' && path === '/events-by-correlation') {
        const result = await this.listEventsByCorrelationId({
          correlationId: url.searchParams.get('correlationId') ?? '',
          limit: parseInt(url.searchParams.get('limit') ?? '100', 10),
          cursor: url.searchParams.get('cursor') ?? undefined,
          sortOrder:
            (url.searchParams.get('sortOrder') as 'asc' | 'desc') ?? 'asc',
          resolveData:
            (url.searchParams.get('resolveData') as ResolveData) ?? 'all',
        });
        return Response.json(result);
      }

      // GET /steps — list steps
      if (method === 'GET' && path === '/steps') {
        const result = await this.listSteps({
          limit: parseInt(url.searchParams.get('limit') ?? '20', 10),
          cursor: url.searchParams.get('cursor') ?? undefined,
          resolveData:
            (url.searchParams.get('resolveData') as ResolveData) ?? 'all',
        });
        return Response.json(result);
      }

      // GET /steps/:stepId — get single step
      if (method === 'GET' && path.startsWith('/steps/')) {
        const stepId = path.slice('/steps/'.length);
        const resolveData =
          (url.searchParams.get('resolveData') as ResolveData) ?? 'all';
        const step = await this.getStep(stepId, resolveData);
        return Response.json(step);
      }

      // GET /hooks — list hooks
      if (method === 'GET' && path === '/hooks') {
        const result = await this.listHooks({
          limit: parseInt(url.searchParams.get('limit') ?? '100', 10),
          cursor: url.searchParams.get('cursor') ?? undefined,
          sortOrder:
            (url.searchParams.get('sortOrder') as 'asc' | 'desc') ?? 'asc',
          resolveData:
            (url.searchParams.get('resolveData') as ResolveData) ?? 'all',
        });
        return Response.json(result);
      }

      // GET /hooks/:hookId — get single hook
      if (method === 'GET' && path.startsWith('/hooks/')) {
        const hookId = path.slice('/hooks/'.length);
        const resolveData =
          (url.searchParams.get('resolveData') as ResolveData) ?? 'all';
        const hook = await this.getHook(hookId, resolveData);
        return Response.json(hook);
      }

      // POST /streams/:name/write — write stream chunk
      if (method === 'POST' && path.match(/^\/streams\/[^/]+\/write$/)) {
        const name = path.split('/')[2];
        const body = (await request.json()) as {
          chunk: number[] | string;
          runId: string;
        };
        await this.writeStreamChunk(name, body.chunk, body.runId);
        return new Response(null, { status: 204 });
      }

      // POST /streams/:name/write-multi — write multiple stream chunks
      if (method === 'POST' && path.match(/^\/streams\/[^/]+\/write-multi$/)) {
        const name = path.split('/')[2];
        const body = (await request.json()) as {
          chunks: (number[] | string)[];
          runId: string;
        };
        await this.writeStreamChunks(name, body.chunks, body.runId);
        return new Response(null, { status: 204 });
      }

      // POST /streams/:name/close — close stream
      if (method === 'POST' && path.match(/^\/streams\/[^/]+\/close$/)) {
        const name = path.split('/')[2];
        const body = (await request.json()) as { runId: string };
        await this.closeStream(name, body.runId);
        return new Response(null, { status: 204 });
      }

      // GET /streams/:name/read — read stream
      if (method === 'GET' && path.match(/^\/streams\/[^/]+\/read$/)) {
        const name = path.split('/')[2];
        const startIndex = parseInt(
          url.searchParams.get('startIndex') ?? '0',
          10
        );
        const stream = await this.readStream(name, startIndex);
        return new Response(stream, {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }

      // GET /streams — list stream names
      if (method === 'GET' && path === '/streams') {
        const names = await this.listStreams();
        return Response.json(names);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      const status = err.status ?? err.statusCode ?? 500;
      return Response.json(
        {
          error: err.message,
          code: err.code,
          meta: err.meta,
        },
        { status }
      );
    }
  }

  // ============================================================
  // Run CRUD
  // ============================================================

  private async getRun(
    resolveData: ResolveData
  ): Promise<WorkflowRun | WorkflowRunWithoutData> {
    const run = await this.storage.get<WorkflowRun>(KEY.run);
    if (!run) {
      throw new WorkflowAPIError('Run not found', { status: 404 });
    }
    const parsed = WorkflowRunSchema.parse(run);
    return filterRunData(parsed, resolveData);
  }

  // ============================================================
  // Event processing — core logic ported from world-postgres
  // ============================================================

  private async createEvent(
    runId: string | null,
    data: any,
    params?: { resolveData?: ResolveData; v1Compat?: boolean }
  ): Promise<EventResult> {
    const eventId = `wevt_${ulid()}`;
    const resolveData = params?.resolveData ?? 'all';

    // For run_created: generate runId if not provided
    let effectiveRunId: string;
    if (data.eventType === 'run_created' && (!runId || runId === '')) {
      effectiveRunId = `wrun_${ulid()}`;
    } else if (!runId) {
      throw new Error('runId is required for non-run_created events');
    } else {
      effectiveRunId = runId;
    }

    // Validate client-provided runId timestamp
    if (data.eventType === 'run_created' && runId && runId !== '') {
      const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
      if (validationError) {
        throw new WorkflowAPIError(validationError, { status: 400 });
      }
    }

    const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const now = new Date();

    let run: WorkflowRun | undefined;
    let step: Step | undefined;
    let hook: Hook | undefined;
    let wait: Wait | undefined;

    const isRunTerminal = (status: string) =>
      ['completed', 'failed', 'cancelled'].includes(status);
    const isStepTerminal = (status: string) =>
      ['completed', 'failed'].includes(status);

    // ============================================================
    // VALIDATION
    // ============================================================

    let currentRun: WorkflowRun | undefined;
    const skipRunValidationEvents = ['step_completed', 'step_retrying'];
    if (
      data.eventType !== 'run_created' &&
      !skipRunValidationEvents.includes(data.eventType)
    ) {
      currentRun = await this.storage.get<WorkflowRun>(KEY.run);
    }

    // Version compatibility check
    if (currentRun) {
      if (requiresNewerWorld(currentRun.specVersion)) {
        throw new RunNotSupportedError(
          currentRun.specVersion ?? 0,
          SPEC_VERSION_CURRENT
        );
      }

      if (isLegacySpecVersion(currentRun.specVersion)) {
        return this.handleLegacyEvent(
          effectiveRunId,
          eventId,
          data,
          currentRun,
          params
        );
      }
    }

    // Run terminal state validation
    if (currentRun && isRunTerminal(currentRun.status)) {
      const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

      // Idempotent: run_cancelled on already cancelled run
      if (
        data.eventType === 'run_cancelled' &&
        currentRun.status === 'cancelled'
      ) {
        const event = await this.insertEvent(
          effectiveRunId,
          eventId,
          data,
          effectiveSpecVersion
        );
        return {
          event: filterEventData(event, resolveData),
          run: filterRunData(currentRun, resolveData) as WorkflowRun,
        };
      }

      if (
        runTerminalEvents.includes(data.eventType) ||
        data.eventType === 'run_cancelled'
      ) {
        throw new WorkflowAPIError(
          `Cannot transition run from terminal state "${currentRun.status}"`,
          { status: 409 }
        );
      }

      if (
        data.eventType === 'step_created' ||
        data.eventType === 'hook_created' ||
        data.eventType === 'wait_created'
      ) {
        throw new WorkflowAPIError(
          `Cannot create new entities on run in terminal state "${currentRun.status}"`,
          { status: 409 }
        );
      }
    }

    // Step validation for step_started, step_retrying
    let validatedStep: Step | undefined;
    const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
    if (
      stepEventsNeedingValidation.includes(data.eventType) &&
      data.correlationId
    ) {
      validatedStep = await this.storage.get<Step>(
        KEY.step(data.correlationId)
      );
      if (!validatedStep) {
        throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }
      if (isStepTerminal(validatedStep.status)) {
        throw new WorkflowAPIError(
          `Cannot modify step in terminal state "${validatedStep.status}"`,
          { status: 409 }
        );
      }
      if (currentRun && isRunTerminal(currentRun.status)) {
        if (validatedStep.status !== 'running') {
          throw new WorkflowAPIError(
            `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
            { status: 410 }
          );
        }
      }
    }

    // Hook validation for hook_disposed, hook_received
    const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
    if (
      hookEventsRequiringExistence.includes(data.eventType) &&
      data.correlationId
    ) {
      const existingHook = await this.storage.get<Hook>(
        KEY.hook(data.correlationId)
      );
      if (!existingHook) {
        throw new WorkflowAPIError(`Hook "${data.correlationId}" not found`, {
          status: 404,
        });
      }
    }

    // ============================================================
    // Entity creation/updates
    // ============================================================

    if (data.eventType === 'run_created') {
      const eventData = data.eventData as {
        deploymentId: string;
        workflowName: string;
        input: any;
        executionContext?: Record<string, any>;
      };
      const newRun: WorkflowRun = WorkflowRunSchema.parse({
        runId: effectiveRunId,
        deploymentId: eventData.deploymentId,
        workflowName: eventData.workflowName,
        specVersion: effectiveSpecVersion,
        input: eventData.input,
        executionContext: eventData.executionContext,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      await this.storage.put(KEY.run, newRun);
      run = newRun;

      // Update D1 index (fire-and-forget)
      this.updateRunIndex(newRun);
    }

    if (data.eventType === 'run_started') {
      const existing =
        currentRun ?? (await this.storage.get<WorkflowRun>(KEY.run));
      if (existing) {
        const updated: WorkflowRun = WorkflowRunSchema.parse({
          ...existing,
          status: 'running',
          startedAt: now,
          updatedAt: now,
        });
        await this.storage.put(KEY.run, updated);
        run = updated;
        this.updateRunIndex(updated);
      }
    }

    if (data.eventType === 'run_completed') {
      const eventData = data.eventData as { output?: any };
      const existing =
        currentRun ?? (await this.storage.get<WorkflowRun>(KEY.run));
      if (existing) {
        const updated: WorkflowRun = WorkflowRunSchema.parse({
          ...existing,
          status: 'completed',
          output: eventData.output,
          completedAt: now,
          updatedAt: now,
        });
        await this.storage.put(KEY.run, updated);
        run = updated;
        this.updateRunIndex(updated);
        await this.disposeAllHooksAndWaits(effectiveRunId);
      }
    }

    if (data.eventType === 'run_failed') {
      const eventData = data.eventData as {
        error: any;
        errorCode?: string;
      };
      const errorMessage =
        typeof eventData.error === 'string'
          ? eventData.error
          : (eventData.error?.message ?? 'Unknown error');
      const existing =
        currentRun ?? (await this.storage.get<WorkflowRun>(KEY.run));
      if (existing) {
        const updated: WorkflowRun = WorkflowRunSchema.parse({
          ...existing,
          status: 'failed',
          error: {
            message: errorMessage,
            stack: eventData.error?.stack,
            code: eventData.errorCode,
          },
          completedAt: now,
          updatedAt: now,
        });
        await this.storage.put(KEY.run, updated);
        run = updated;
        this.updateRunIndex(updated);
        await this.disposeAllHooksAndWaits(effectiveRunId);
      }
    }

    if (data.eventType === 'run_cancelled') {
      const existing =
        currentRun ?? (await this.storage.get<WorkflowRun>(KEY.run));
      if (existing) {
        const updated: WorkflowRun = WorkflowRunSchema.parse({
          ...existing,
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
        });
        await this.storage.put(KEY.run, updated);
        run = updated;
        this.updateRunIndex(updated);
        await this.disposeAllHooksAndWaits(effectiveRunId);
      }
    }

    if (data.eventType === 'step_created') {
      const eventData = data.eventData as {
        stepName: string;
        input: any;
      };
      const newStep: Step = StepSchema.parse({
        runId: effectiveRunId,
        stepId: data.correlationId,
        stepName: eventData.stepName,
        input: eventData.input,
        status: 'pending',
        attempt: 0,
        specVersion: effectiveSpecVersion,
        createdAt: now,
        updatedAt: now,
      });
      // Only create if doesn't exist (onConflictDoNothing equivalent)
      const existing = await this.storage.get(KEY.step(data.correlationId));
      if (!existing) {
        await this.storage.put(KEY.step(data.correlationId), newStep);
        step = newStep;
      }
    }

    if (data.eventType === 'step_started') {
      if (!validatedStep) {
        throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }

      // Check retryAfter
      if (
        validatedStep.retryAfter &&
        validatedStep.retryAfter.getTime() > Date.now()
      ) {
        const err = new WorkflowAPIError(
          `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
          { status: 425 }
        );
        (err as any).meta = {
          stepId: data.correlationId,
          retryAfter: validatedStep.retryAfter.toISOString(),
        };
        throw err;
      }

      const isFirstStart = !validatedStep.startedAt;
      const updated: Step = StepSchema.parse({
        ...validatedStep,
        status: 'running',
        attempt: validatedStep.attempt + 1,
        ...(isFirstStart ? { startedAt: now } : {}),
        retryAfter: undefined,
        updatedAt: now,
      });
      await this.storage.put(KEY.step(data.correlationId), updated);
      step = updated;
    }

    if (data.eventType === 'step_completed') {
      const eventData = data.eventData as { result?: any };
      const existingStep = await this.storage.get<Step>(
        KEY.step(data.correlationId)
      );
      if (!existingStep) {
        throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }
      if (isStepTerminal(existingStep.status)) {
        throw new WorkflowAPIError(
          `Cannot modify step in terminal state "${existingStep.status}"`,
          { status: 409 }
        );
      }
      const updated: Step = StepSchema.parse({
        ...existingStep,
        status: 'completed',
        output: eventData.result,
        completedAt: now,
        updatedAt: now,
      });
      await this.storage.put(KEY.step(data.correlationId), updated);
      step = updated;
    }

    if (data.eventType === 'step_failed') {
      const eventData = data.eventData as {
        error?: any;
        stack?: string;
      };
      const errorMessage =
        typeof eventData.error === 'string'
          ? eventData.error
          : (eventData.error?.message ?? 'Unknown error');
      const existingStep = await this.storage.get<Step>(
        KEY.step(data.correlationId)
      );
      if (!existingStep) {
        throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }
      if (isStepTerminal(existingStep.status)) {
        throw new WorkflowAPIError(
          `Cannot modify step in terminal state "${existingStep.status}"`,
          { status: 409 }
        );
      }
      const updated: Step = StepSchema.parse({
        ...existingStep,
        status: 'failed',
        error: { message: errorMessage, stack: eventData.stack },
        completedAt: now,
        updatedAt: now,
      });
      await this.storage.put(KEY.step(data.correlationId), updated);
      step = updated;
    }

    if (data.eventType === 'step_retrying') {
      const eventData = data.eventData as {
        error?: any;
        stack?: string;
        retryAfter?: string;
      };
      const errorMessage =
        typeof eventData.error === 'string'
          ? eventData.error
          : (eventData.error?.message ?? 'Unknown error');
      const existingStep =
        validatedStep ??
        (await this.storage.get<Step>(KEY.step(data.correlationId)));
      if (existingStep) {
        const updated: Step = StepSchema.parse({
          ...existingStep,
          status: 'pending',
          error: { message: errorMessage, stack: eventData.stack },
          retryAfter: eventData.retryAfter
            ? new Date(eventData.retryAfter)
            : undefined,
          updatedAt: now,
        });
        await this.storage.put(KEY.step(data.correlationId), updated);
        step = updated;
      }
    }

    if (data.eventType === 'hook_created') {
      const eventData = data.eventData as {
        token: string;
        metadata?: any;
        isWebhook?: boolean;
      };

      // Check for duplicate token
      const existingTokenHookId = await this.storage.get<string>(
        KEY.hookToken(eventData.token)
      );
      if (existingTokenHookId) {
        // Create hook_conflict event
        const conflictEventData = { token: eventData.token };
        const conflictEvent = EventSchema.parse({
          eventType: 'hook_conflict',
          correlationId: data.correlationId,
          eventData: conflictEventData,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        });
        await this.storage.put(KEY.event(eventId), conflictEvent);
        return {
          event: filterEventData(conflictEvent, resolveData),
          hook: undefined,
        };
      }

      const newHook: Hook = HookSchema.parse({
        runId: effectiveRunId,
        hookId: data.correlationId,
        token: eventData.token,
        metadata: eventData.metadata,
        ownerId: '',
        projectId: '',
        environment: '',
        specVersion: effectiveSpecVersion,
        isWebhook: eventData.isWebhook,
        createdAt: now,
      });

      // Only create if doesn't exist
      const existing = await this.storage.get(KEY.hook(data.correlationId));
      if (!existing) {
        await this.storage.put(KEY.hook(data.correlationId), newHook);
        await this.storage.put(
          KEY.hookToken(eventData.token),
          data.correlationId
        );
        hook = newHook;

        // Update D1 index (fire-and-forget)
        insertHookIndex(this.db, {
          hookId: data.correlationId,
          runId: effectiveRunId,
          token: eventData.token,
          ownerId: '',
          projectId: '',
          environment: '',
          createdAt: now.toISOString(),
          isWebhook: eventData.isWebhook,
          specVersion: effectiveSpecVersion,
        }).catch(() => {});
      }
    }

    if (data.eventType === 'hook_disposed' && data.correlationId) {
      const existingHook = await this.storage.get<Hook>(
        KEY.hook(data.correlationId)
      );
      if (existingHook) {
        await this.storage.delete(KEY.hook(data.correlationId));
        await this.storage.delete(KEY.hookToken(existingHook.token));
        deleteHookIndex(this.db, data.correlationId).catch(() => {});
      }
    }

    if (data.eventType === 'wait_created') {
      const eventData = data.eventData as { resumeAt?: string };
      const waitId = `${effectiveRunId}-${data.correlationId}`;
      const existing = await this.storage.get(KEY.wait(waitId));
      if (existing) {
        throw new WorkflowAPIError(
          `Wait "${data.correlationId}" already exists`,
          { status: 409 }
        );
      }
      const newWait: Wait = {
        waitId,
        runId: effectiveRunId,
        status: 'waiting',
        resumeAt: eventData.resumeAt ? new Date(eventData.resumeAt) : undefined,
        createdAt: now,
        updatedAt: now,
        specVersion: effectiveSpecVersion,
      };
      await this.storage.put(KEY.wait(waitId), newWait);
      wait = newWait;
    }

    if (data.eventType === 'wait_completed') {
      const waitId = `${effectiveRunId}-${data.correlationId}`;
      const existingWait = await this.storage.get<Wait>(KEY.wait(waitId));
      if (!existingWait) {
        throw new WorkflowAPIError(`Wait "${data.correlationId}" not found`, {
          status: 404,
        });
      }
      if (existingWait.status === 'completed') {
        throw new WorkflowAPIError(
          `Wait "${data.correlationId}" already completed`,
          { status: 409 }
        );
      }
      const updated: Wait = {
        ...existingWait,
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      };
      await this.storage.put(KEY.wait(waitId), updated);
      wait = updated;
    }

    // Insert the event into DO storage
    const event = await this.insertEvent(
      effectiveRunId,
      eventId,
      data,
      effectiveSpecVersion
    );

    return {
      event: filterEventData(event, resolveData),
      run: run ? (filterRunData(run, resolveData) as WorkflowRun) : undefined,
      step,
      hook,
      wait,
    };
  }

  private async insertEvent(
    runId: string,
    eventId: string,
    data: any,
    specVersion: number
  ): Promise<Event> {
    const now = new Date();
    const event = EventSchema.parse({
      ...data,
      runId,
      eventId,
      createdAt: now,
      specVersion,
    });
    await this.storage.put(KEY.event(eventId), event);
    return event;
  }

  private async handleLegacyEvent(
    runId: string,
    eventId: string,
    data: any,
    currentRun: WorkflowRun,
    params?: { resolveData?: ResolveData }
  ): Promise<EventResult> {
    const resolveData = params?.resolveData ?? 'all';
    const now = new Date();

    switch (data.eventType) {
      case 'run_cancelled': {
        const updated: WorkflowRun = WorkflowRunSchema.parse({
          ...currentRun,
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
        });
        await this.storage.put(KEY.run, updated);
        await this.disposeAllHooksAndWaits(runId);
        this.updateRunIndex(updated);
        return {
          run: filterRunData(updated, resolveData) as WorkflowRun,
        };
      }

      case 'wait_completed':
      case 'hook_received': {
        const event = await this.insertEvent(
          runId,
          eventId,
          data,
          SPEC_VERSION_CURRENT
        );
        return { event: filterEventData(event, resolveData) };
      }

      default:
        throw new Error(
          `Event type '${data.eventType}' not supported for legacy runs ` +
            `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
            `Please upgrade @workflow packages.`
        );
    }
  }

  private async disposeAllHooksAndWaits(runId: string): Promise<void> {
    // Delete all hooks
    const hookEntries = await this.storage.list<Hook>({ prefix: 'hook:' });
    const keysToDelete: string[] = [];
    for (const [key, hookValue] of hookEntries) {
      keysToDelete.push(key);
      if (hookValue && typeof hookValue === 'object' && 'token' in hookValue) {
        keysToDelete.push(KEY.hookToken(hookValue.token));
      }
    }

    // Delete all waits
    const waitEntries = await this.storage.list({ prefix: 'wait:' });
    for (const [key] of waitEntries) {
      keysToDelete.push(key);
    }

    if (keysToDelete.length > 0) {
      await this.storage.delete(keysToDelete);
    }

    // Delete from D1 index
    deleteHooksForRunIndex(this.db, runId).catch(() => {});
  }

  private updateRunIndex(run: WorkflowRun): void {
    upsertRunIndex(this.db, {
      runId: run.runId,
      workflowName: run.workflowName,
      status: run.status,
      deploymentId: run.deploymentId,
      specVersion: run.specVersion,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      startedAt: toISOOrUndef(run.startedAt),
      completedAt: toISOOrUndef(run.completedAt),
      expiredAt: toISOOrUndef(run.expiredAt),
    }).catch(() => {});
  }

  // ============================================================
  // Event reads
  // ============================================================

  private async getEvent(
    eventId: string,
    resolveData: ResolveData
  ): Promise<Event> {
    const event = await this.storage.get<Event>(KEY.event(eventId));
    if (!event) {
      throw new WorkflowAPIError(`Event not found: ${eventId}`, {
        status: 404,
      });
    }
    return filterEventData(event, resolveData);
  }

  private async listEvents(params: {
    limit: number;
    cursor?: string;
    sortOrder: 'asc' | 'desc';
    resolveData: ResolveData;
  }): Promise<PaginatedResponse<Event>> {
    const all = await this.storage.list<Event>({ prefix: 'evt:' });
    let entries = [...all.entries()].map(([, v]) => v);

    if (params.sortOrder === 'desc') {
      entries.reverse();
    }

    // Apply cursor
    if (params.cursor) {
      const idx = entries.findIndex((e) => e.eventId === params.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      }
    }

    const data = entries.slice(0, params.limit);
    const hasMore = entries.length > params.limit;

    return {
      data: data.map((e) => filterEventData(e, params.resolveData)),
      cursor: data.at(-1)?.eventId ?? null,
      hasMore,
    };
  }

  private async listEventsByCorrelationId(params: {
    correlationId: string;
    limit: number;
    cursor?: string;
    sortOrder: 'asc' | 'desc';
    resolveData: ResolveData;
  }): Promise<PaginatedResponse<Event>> {
    const all = await this.storage.list<Event>({ prefix: 'evt:' });
    let entries = [...all.entries()]
      .map(([, v]) => v)
      .filter((e) => e.correlationId === params.correlationId);

    if (params.sortOrder === 'desc') {
      entries.reverse();
    }

    if (params.cursor) {
      const idx = entries.findIndex((e) => e.eventId === params.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      }
    }

    const data = entries.slice(0, params.limit);
    const hasMore = entries.length > params.limit;

    return {
      data: data.map((e) => filterEventData(e, params.resolveData)),
      cursor: data.at(-1)?.eventId ?? null,
      hasMore,
    };
  }

  // ============================================================
  // Step reads
  // ============================================================

  private async getStep(
    stepId: string,
    resolveData: ResolveData
  ): Promise<Step | StepWithoutData> {
    const step = await this.storage.get<Step>(KEY.step(stepId));
    if (!step) {
      throw new WorkflowAPIError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }
    const parsed = StepSchema.parse(step);
    return filterStepData(parsed, resolveData);
  }

  private async listSteps(params: {
    limit: number;
    cursor?: string;
    resolveData: ResolveData;
  }): Promise<PaginatedResponse<Step | StepWithoutData>> {
    const all = await this.storage.list<Step>({ prefix: 'step:' });
    let entries = [...all.entries()]
      .map(([, v]) => v)
      .sort((a, b) => (b.stepId > a.stepId ? 1 : -1)); // desc by stepId

    if (params.cursor) {
      const idx = entries.findIndex((e) => e.stepId === params.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      }
    }

    const data = entries.slice(0, params.limit);
    const hasMore = entries.length > params.limit;

    return {
      data: data.map((s) => {
        const parsed = StepSchema.parse(s);
        return filterStepData(parsed, params.resolveData);
      }),
      cursor: data.at(-1)?.stepId ?? null,
      hasMore,
    };
  }

  // ============================================================
  // Hook reads
  // ============================================================

  private async getHook(
    hookId: string,
    resolveData: ResolveData
  ): Promise<Hook> {
    const hook = await this.storage.get<Hook>(KEY.hook(hookId));
    if (!hook) {
      throw new HookNotFoundError(hookId);
    }
    const parsed = HookSchema.parse(hook);
    parsed.isWebhook ??= true;
    return filterHookData(parsed, resolveData);
  }

  private async listHooks(params: {
    limit: number;
    cursor?: string;
    sortOrder: 'asc' | 'desc';
    resolveData: ResolveData;
  }): Promise<PaginatedResponse<Hook>> {
    const all = await this.storage.list<Hook>({ prefix: 'hook:' });
    let entries = [...all.entries()]
      .filter(([key]) => !key.startsWith('hook_tok:'))
      .map(([, v]) => v);

    if (params.sortOrder === 'desc') {
      entries.reverse();
    }

    if (params.cursor) {
      const idx = entries.findIndex((e) => e.hookId === params.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      }
    }

    const data = entries.slice(0, params.limit);
    const hasMore = entries.length > params.limit;

    return {
      data: data.map((h) => {
        const parsed = HookSchema.parse(h);
        parsed.isWebhook ??= true;
        return filterHookData(parsed, params.resolveData);
      }),
      cursor: data.at(-1)?.hookId ?? null,
      hasMore,
    };
  }

  // ============================================================
  // Stream operations
  // ============================================================

  private async writeStreamChunk(
    streamId: string,
    chunk: number[] | string,
    _runId: string
  ): Promise<void> {
    const chunkId = `chnk_${ulid()}`;
    const data: StreamChunkData = {
      data:
        typeof chunk === 'string'
          ? [...new TextEncoder().encode(chunk)]
          : chunk,
      eof: false,
    };
    await this.storage.put(KEY.streamChunk(streamId, chunkId), data);
    await this.ensureStreamIndexed(streamId);
  }

  private async writeStreamChunks(
    streamId: string,
    chunks: (number[] | string)[],
    _runId: string
  ): Promise<void> {
    if (chunks.length === 0) return;
    const entries: Record<string, StreamChunkData> = {};
    for (const chunk of chunks) {
      const chunkId = `chnk_${ulid()}`;
      entries[KEY.streamChunk(streamId, chunkId)] = {
        data:
          typeof chunk === 'string'
            ? [...new TextEncoder().encode(chunk)]
            : chunk,
        eof: false,
      };
    }
    await this.storage.put(entries);
    await this.ensureStreamIndexed(streamId);
  }

  private async closeStream(streamId: string, _runId: string): Promise<void> {
    const chunkId = `chnk_${ulid()}`;
    const data: StreamChunkData = { data: [], eof: true };
    await this.storage.put(KEY.streamChunk(streamId, chunkId), data);
    await this.storage.put(KEY.streamMeta(streamId), { eof: true });
  }

  private async readStream(
    streamId: string,
    startIndex: number
  ): Promise<ReadableStream<Uint8Array>> {
    const prefix = `strm:${streamId}:chnk:`;
    const all = await this.storage.list<StreamChunkData>({ prefix });
    const chunks = [...all.entries()].map(([, v]) => v).slice(startIndex);

    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          if (chunk.data.length > 0) {
            controller.enqueue(new Uint8Array(chunk.data));
          }
          if (chunk.eof) {
            controller.close();
            return;
          }
        }
        // If no EOF chunk found, close anyway (stream may still be open)
        controller.close();
      },
    });
  }

  private async listStreams(): Promise<string[]> {
    return (await this.storage.get<string[]>(KEY.streamIndex)) ?? [];
  }

  private async ensureStreamIndexed(streamId: string): Promise<void> {
    const streams = (await this.storage.get<string[]>(KEY.streamIndex)) ?? [];
    if (!streams.includes(streamId)) {
      streams.push(streamId);
      await this.storage.put(KEY.streamIndex, streams);
    }
  }
}
