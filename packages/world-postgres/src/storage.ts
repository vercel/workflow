import { WorkflowAPIError } from '@workflow/errors';
import type {
  Event,
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  StepSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

/**
 * Serialize a StructuredError object into a JSON string
 */
function serializeRunError(data: UpdateWorkflowRunRequest): any {
  if (!data.error) {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: JSON.stringify({
      message: error.message,
      stack: error.stack,
      code: error.code,
    }),
  };
}

/**
 * Deserialize error JSON string (or legacy flat fields) into a StructuredError object
 * Handles backwards compatibility:
 * - If error is a JSON string with {message, stack, code} → parse into StructuredError
 * - If error is a plain string → treat as error message
 * - If errorStack/errorCode exist (legacy) → combine into StructuredError
 */
function deserializeRunError(run: any): WorkflowRun {
  const { error, errorStack, errorCode, ...rest } = run;

  if (!error && !errorStack && !errorCode) {
    return run as WorkflowRun;
  }

  // Try to parse as structured error JSON
  if (error) {
    try {
      const parsed = JSON.parse(error);
      if (typeof parsed === 'object' && parsed.message !== undefined) {
        return {
          ...rest,
          error: {
            message: parsed.message,
            stack: parsed.stack,
            code: parsed.code,
          },
        } as WorkflowRun;
      }
    } catch {
      // Not JSON, treat as plain string
    }
  }

  // Backwards compatibility: handle legacy separate fields or plain string error
  return {
    ...rest,
    error: {
      message: error || '',
      stack: errorStack,
      code: errorCode,
    },
  } as WorkflowRun;
}

/**
 * Serialize a StructuredError object into a JSON string for steps
 */
function serializeStepError(data: UpdateStepRequest): any {
  if (!data.error) {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: JSON.stringify({
      message: error.message,
      stack: error.stack,
      code: error.code,
    }),
  };
}

/**
 * Deserialize error JSON string (or legacy flat fields) into a StructuredError object for steps
 */
function deserializeStepError(step: any): Step {
  const { error, ...rest } = step;

  if (!error) {
    return step as Step;
  }

  // Try to parse as structured error JSON
  if (error) {
    try {
      const parsed = JSON.parse(error);
      if (typeof parsed === 'object' && parsed.message !== undefined) {
        return {
          ...rest,
          error: {
            message: parsed.message,
            stack: parsed.stack,
            code: parsed.code,
          },
        } as Step;
      }
    } catch {
      // Not JSON, treat as plain string
    }
  }

  // Backwards compatibility: handle legacy separate fields or plain string error
  return {
    ...rest,
    error: {
      message: error || '',
    },
  } as Step;
}

export function createRunsStorage(drizzle: Drizzle): Storage['runs'] {
  const ulid = monotonicFactory();
  const { runs } = Schema;
  const get = drizzle
    .select()
    .from(runs)
    .where(eq(runs.runId, sql.placeholder('id')))
    .limit(1)
    .prepare('workflow_runs_get');

  return {
    async get(id, params) {
      const [value] = await get.execute({ id });
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.executionContext ||= value.executionContextJson;
      const deserialized = deserializeRunError(compact(value));
      const parsed = WorkflowRunSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    },
    async cancel(id, params) {
      // TODO: we might want to guard this for only specific statuses
      const [value] = await drizzle
        .update(Schema.runs)
        .set({ status: 'cancelled', completedAt: sql`now()` })
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Clean up all hooks for this run when cancelling
      await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, id));

      const deserialized = deserializeRunError(compact(value));
      const parsed = WorkflowRunSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c) => lt(runs.runId, c)),
            map(params?.workflowName, (wf) => eq(runs.workflowName, wf)),
            map(params?.status, (wf) => eq(runs.status, wf))
          )
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          const deserialized = deserializeRunError(compact(v));
          const parsed = WorkflowRunSchema.parse(deserialized);
          return filterRunData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    },
    async create(data) {
      const runId = `wrun_${ulid()}`;
      const [value] = await drizzle
        .insert(runs)
        .values({
          runId,
          input: data.input,
          executionContext: data.executionContext as Record<
            string,
            unknown
          > | null,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
        })
        .onConflictDoNothing()
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run ${runId} already exists`, {
          status: 409,
        });
      }
      return deserializeRunError(compact(value));
    },
    async update(id, data) {
      // Fetch current run to check if startedAt is already set
      const [currentRun] = await drizzle
        .select()
        .from(runs)
        .where(eq(runs.runId, id))
        .limit(1);

      if (!currentRun) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Serialize the error field if present
      const serialized = serializeRunError(data);

      const updates: Partial<typeof runs._.inferInsert> = {
        ...serialized,
        output: data.output as SerializedContent,
      };

      // Only set startedAt the first time transitioning to 'running'
      if (data.status === 'running' && !currentRun.startedAt) {
        updates.startedAt = new Date();
      }

      const isBecomingTerminal =
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled';

      if (isBecomingTerminal) {
        updates.completedAt = new Date();
      }

      const [value] = await drizzle
        .update(runs)
        .set(updates)
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // If transitioning to a terminal status, clean up all hooks for this run
      if (isBecomingTerminal) {
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, id));
      }

      return deserializeRunError(compact(value));
    },
  };
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

export function createEventsStorage(drizzle: Drizzle): Storage['events'] {
  const ulid = monotonicFactory();
  const { events } = Schema;

  return {
    async create(runId, data, params) {
      const eventId = `wevt_${ulid()}`;
      const [value] = await drizzle
        .insert(events)
        .values({
          runId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
        })
        .returning({ createdAt: events.createdAt });
      if (!value) {
        throw new WorkflowAPIError(`Event ${eventId} could not be created`, {
          status: 409,
        });
      }
      const result = { ...data, ...value, runId, eventId };
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? 'all';
      return filterEventData(parsed, resolveData);
    },
    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.runId, params.runId),
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
  };
}

export function createHooksStorage(drizzle: Drizzle): Storage['hooks'] {
  const { hooks } = Schema;
  const getByToken = drizzle
    .select()
    .from(hooks)
    .where(eq(hooks.token, sql.placeholder('token')))
    .limit(1)
    .prepare('workflow_hooks_get_by_token');

  return {
    async get(hookId, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(eq(hooks.hookId, hookId))
        .limit(1);
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async create(runId, data, params) {
      const [value] = await drizzle
        .insert(hooks)
        .values({
          runId,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata as SerializedContent,
          ownerId: '', // TODO: get from context
          projectId: '', // TODO: get from context
          environment: '', // TODO: get from context
        })
        .onConflictDoNothing()
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Hook ${data.hookId} already exists`, {
          status: 409,
        });
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async list(params: ListHooksParams) {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;
      const all = await drizzle
        .select()
        .from(hooks)
        .where(
          and(
            map(params.runId, (id) => eq(hooks.runId, id)),
            map(fromCursor, (c) => lt(hooks.hookId, c))
          )
        )
        .orderBy(desc(hooks.hookId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.metadata ||= v.metadataJson;
          const parsed = HookSchema.parse(compact(v));
          return filterHookData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
    async dispose(hookId, params) {
      const [value] = await drizzle
        .delete(hooks)
        .where(eq(hooks.hookId, hookId))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
  };
}

export function createStepsStorage(drizzle: Drizzle): Storage['steps'] {
  const { steps } = Schema;

  return {
    async create(runId, data) {
      const [value] = await drizzle
        .insert(steps)
        .values({
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          input: data.input as SerializedContent,
          status: 'pending',
          attempt: 0,
        })
        .onConflictDoNothing()
        .returning();

      if (!value) {
        throw new WorkflowAPIError(`Step ${data.stepId} already exists`, {
          status: 409,
        });
      }
      return deserializeStepError(compact(value));
    },

    async get(runId, stepId, params) {
      // If runId is not provided, query only by stepId
      const whereClause = runId
        ? and(eq(steps.stepId, stepId), eq(steps.runId, runId))
        : eq(steps.stepId, stepId);

      const [value] = await drizzle
        .select()
        .from(steps)
        .where(whereClause)
        .limit(1);

      if (!value) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      value.output ||= value.outputJson;
      const deserialized = deserializeStepError(compact(value));
      const parsed = StepSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(parsed, resolveData);
    },
    async update(runId, stepId, data) {
      // Fetch current step to check if startedAt is already set
      const [currentStep] = await drizzle
        .select()
        .from(steps)
        .where(and(eq(steps.stepId, stepId), eq(steps.runId, runId)))
        .limit(1);

      if (!currentStep) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      // Serialize the error field if present
      const serialized = serializeStepError(data);

      const updates: Partial<typeof steps._.inferInsert> = {
        ...serialized,
        output: data.output as SerializedContent,
      };
      const now = new Date();
      // Only set startedAt the first time the step transitions to 'running'
      if (data.status === 'running' && !currentStep.startedAt) {
        updates.startedAt = now;
      }
      if (data.status === 'completed' || data.status === 'failed') {
        updates.completedAt = now;
      }
      const [value] = await drizzle
        .update(steps)
        .set(updates)
        .where(and(eq(steps.stepId, stepId), eq(steps.runId, runId)))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      return deserializeStepError(compact(value));
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c) => lt(steps.stepId, c))
          )
        )
        .orderBy(desc(steps.stepId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          const deserialized = deserializeStepError(compact(v));
          const parsed = StepSchema.parse(deserialized);
          return filterStepData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    },
  };
}

function filterStepData(step: Step, resolveData: ResolveData): Step {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;

    return { input: [], output: undefined, ...rest };
  }
  return step;
}

function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = run;

    return { input: [], output: undefined, ...rest };
  }
  return run;
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
