import { WorkflowAPIError } from '@workflow/errors';
import type {
  Event,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  Storage,
} from '@workflow/world';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

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
    async get(id) {
      const [value] = await get.execute({ id });
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return compact(value);
    },
    async cancel(id) {
      // TODO: we might want to guard this for only specific statuses
      const [value] = await drizzle
        .update(Schema.runs)
        .set({ status: 'cancelled', completedAt: sql`now()` })
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return compact(value);
    },
    async pause(id) {
      // TODO: we might want to guard this for only specific statuses
      const [value] = await drizzle
        .update(Schema.runs)
        .set({ status: 'paused' })
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return compact(value);
    },
    async resume(id) {
      const [value] = await drizzle
        .update(Schema.runs)
        .set({ status: 'running' })
        .where(and(eq(runs.runId, id), eq(runs.status, 'paused')))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Paused run not found: ${id}`, {
          status: 404,
        });
      }
      return compact(value);
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

      return {
        data: values.map(compact),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    },
    async create(data) {
      const runId = data.runId ?? `wrun_${ulid()}`;

      // If custom runId provided, check if it already exists for idempotency
      if (data.runId) {
        const [existingRun] = await drizzle
          .select()
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (existingRun) {
          return compact(existingRun);
        }
      }

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

      // If insert returned nothing due to conflict, fetch and return existing run
      if (!value) {
        const [existingRun] = await drizzle
          .select()
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (existingRun) {
          return compact(existingRun);
        }
        throw new WorkflowAPIError(`Run ${runId} already exists`, {
          status: 409,
        });
      }
      return compact(value);
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

      const updates: Partial<typeof runs._.inferInsert> = {
        ...data,
        output: data.output as SerializedContent,
      };

      // Only set startedAt the first time transitioning to 'running'
      if (data.status === 'running' && !currentRun.startedAt) {
        updates.startedAt = new Date();
      }
      if (
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled'
      ) {
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
      return compact(value);
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
    async create(runId, data) {
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
      return { ...data, ...value, runId, eventId };
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

      return {
        data: values.map(compact) as Event[],
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

      return {
        data: values.map(compact) as Event[],
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
    async get(hookId) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(eq(hooks.hookId, hookId))
        .limit(1);
      return compact(value);
    },
    async create(runId, data) {
      const [value] = await drizzle
        .insert(hooks)
        .values({
          runId,
          hookId: data.hookId,
          token: data.token,
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
      return compact(value);
    },
    async getByToken(token) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      }
      return compact(value);
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
      return {
        data: values.map(compact),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
    async dispose(hookId) {
      const [value] = await drizzle
        .delete(hooks)
        .where(eq(hooks.hookId, hookId))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      return compact(value);
    },
  };
}

export function createStepsStorage(drizzle: Drizzle): Storage['steps'] {
  const { steps } = Schema;
  const get = drizzle
    .select()
    .from(steps)
    .where(
      and(
        eq(steps.stepId, sql.placeholder('stepId')),
        eq(steps.runId, sql.placeholder('runId'))
      )
    )
    .limit(1)
    .prepare('workflow_steps_get');

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
          attempt: 1,
        })
        .onConflictDoNothing()
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Step ${data.stepId} already exists`, {
          status: 409,
        });
      }
      return compact(value);
    },
    async get(runId, stepId) {
      const [value] = await get.execute({ stepId, runId });
      if (!value) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      return compact(value);
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

      const updates: Partial<typeof steps._.inferInsert> = {
        ...data,
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
      return compact(value);
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

      return {
        data: values.map(compact),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    },
  };
}
