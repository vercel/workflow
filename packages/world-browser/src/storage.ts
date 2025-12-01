/**
 * Storage implementation for browser using Turso WASM (SQLite).
 */

import { WorkflowAPIError } from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  Event,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunsParams,
  ListWorkflowRunStepsParams,
  PaginatedResponse,
  ResolveData,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { BrowserDatabase } from './schema.js';

const ulid = monotonicFactory();

// Helper to serialize JSON for storage
function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

// Helper to deserialize JSON from storage
function deserialize<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

// Helper to format Date for SQLite
function toSqliteDate(date: Date): string {
  return date.toISOString();
}

// Helper to parse SQLite date
function fromSqliteDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return new Date(value);
}

// Filter helpers based on resolveData
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun {
  if (resolveData === 'none') {
    return { ...run, input: [], output: undefined };
  }
  return run;
}

function filterStepData(step: Step, resolveData: ResolveData): Step {
  if (resolveData === 'none') {
    return { ...step, input: [], output: undefined };
  }
  return step;
}

function filterEventData(event: Event, resolveData: ResolveData): Event {
  if (resolveData === 'none') {
    const { eventData: _, ...rest } = event as Event & { eventData?: unknown };
    return rest as Event;
  }
  return event;
}

function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none') {
    return { ...hook, metadata: undefined };
  }
  return hook;
}

// Row types from database
interface RunRow {
  run_id: string;
  workflow_name: string;
  deployment_id: string;
  status: string;
  input: string | null;
  output: string | null;
  execution_context: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface StepRow {
  step_id: string;
  run_id: string;
  step_name: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_after: string | null;
}

interface EventRow {
  event_id: string;
  run_id: string;
  event_type: string;
  correlation_id: string | null;
  event_data: string | null;
  created_at: string;
}

interface HookRow {
  hook_id: string;
  run_id: string;
  token: string;
  metadata: string | null;
  owner_id: string;
  project_id: string;
  environment: string;
  created_at: string;
}

// Convert database row to WorkflowRun
function rowToRun(row: RunRow): WorkflowRun {
  const error = row.error
    ? deserialize<{ message: string; stack?: string; code?: string }>(row.error)
    : undefined;
  // Use type assertion since WorkflowRun is a discriminated union
  return {
    runId: row.run_id,
    workflowName: row.workflow_name,
    deploymentId: row.deployment_id,
    status: row.status,
    input: deserialize<unknown[]>(row.input) ?? [],
    output: deserialize(row.output),
    executionContext: deserialize<Record<string, unknown>>(
      row.execution_context
    ),
    error,
    createdAt: fromSqliteDate(row.created_at)!,
    updatedAt: fromSqliteDate(row.updated_at)!,
    startedAt: fromSqliteDate(row.started_at),
    completedAt: fromSqliteDate(row.completed_at),
  } as WorkflowRun;
}

// Convert database row to Step
function rowToStep(row: StepRow): Step {
  const error = row.error
    ? deserialize<{ message: string; stack?: string; code?: string }>(row.error)
    : undefined;
  return {
    stepId: row.step_id,
    runId: row.run_id,
    stepName: row.step_name,
    status: row.status as Step['status'],
    input: deserialize<unknown[]>(row.input) ?? [],
    output: deserialize(row.output),
    error,
    attempt: row.attempt,
    createdAt: fromSqliteDate(row.created_at)!,
    updatedAt: fromSqliteDate(row.updated_at)!,
    startedAt: fromSqliteDate(row.started_at),
    completedAt: fromSqliteDate(row.completed_at),
  };
}

// Convert database row to Event
function rowToEvent(row: EventRow): Event {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    eventType: row.event_type as Event['eventType'],
    correlationId: row.correlation_id ?? undefined,
    eventData: deserialize(row.event_data),
    createdAt: fromSqliteDate(row.created_at)!,
  } as Event;
}

// Convert database row to Hook
function rowToHook(row: HookRow): Hook {
  return {
    hookId: row.hook_id,
    runId: row.run_id,
    token: row.token,
    metadata: deserialize(row.metadata),
    ownerId: row.owner_id,
    projectId: row.project_id,
    environment: row.environment,
    createdAt: fromSqliteDate(row.created_at)!,
  };
}

/**
 * Create a Storage implementation using Turso WASM database.
 */
export function createStorage(db: BrowserDatabase): Storage {
  return {
    runs: createRunsStorage(db),
    steps: createStepsStorage(db),
    events: createEventsStorage(db),
    hooks: createHooksStorage(db),
  };
}

function createRunsStorage(db: BrowserDatabase): Storage['runs'] {
  return {
    async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
      const runId = `wrun_${ulid()}`;
      const now = new Date();
      const nowStr = toSqliteDate(now);

      await db
        .prepare(`
        INSERT INTO workflow_runs (run_id, workflow_name, deployment_id, status, input, execution_context, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      `)
        .run([
          runId,
          data.workflowName,
          data.deploymentId,
          serialize(data.input),
          serialize(data.executionContext),
          nowStr,
          nowStr,
        ]);

      return {
        runId,
        workflowName: data.workflowName,
        deploymentId: data.deploymentId,
        status: 'pending',
        input: (data.input as unknown[]) ?? [],
        output: undefined,
        executionContext: data.executionContext as
          | Record<string, unknown>
          | undefined,
        error: undefined,
        createdAt: now,
        updatedAt: now,
        startedAt: undefined,
        completedAt: undefined,
      };
    },

    async get(id: string, params?: GetWorkflowRunParams): Promise<WorkflowRun> {
      const row = await db
        .prepare(`
        SELECT * FROM workflow_runs WHERE run_id = ?
      `)
        .get<RunRow>([id]);

      if (!row) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      const run = rowToRun(row);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(run, resolveData);
    },

    async update(
      id: string,
      data: UpdateWorkflowRunRequest
    ): Promise<WorkflowRun> {
      const existing = await db
        .prepare(`
        SELECT * FROM workflow_runs WHERE run_id = ?
      `)
        .get<RunRow>([id]);

      if (!existing) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      const now = new Date();
      const updates: string[] = ['updated_at = ?'];
      const values: unknown[] = [toSqliteDate(now)];

      if (data.status !== undefined) {
        updates.push('status = ?');
        values.push(data.status);

        // Set startedAt on first transition to running
        if (data.status === 'running' && !existing.started_at) {
          updates.push('started_at = ?');
          values.push(toSqliteDate(now));
        }

        // Set completedAt on terminal states
        if (
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled'
        ) {
          updates.push('completed_at = ?');
          values.push(toSqliteDate(now));
        }
      }

      if (data.output !== undefined) {
        updates.push('output = ?');
        values.push(serialize(data.output));
      }

      if (data.error !== undefined) {
        updates.push('error = ?');
        values.push(serialize(data.error));
      }

      values.push(id);

      await db
        .prepare(`
        UPDATE workflow_runs SET ${updates.join(', ')} WHERE run_id = ?
      `)
        .run(values);

      // Clean up hooks on terminal states
      if (
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled'
      ) {
        await db
          .prepare(`DELETE FROM workflow_hooks WHERE run_id = ?`)
          .run([id]);
      }

      const updated = await db
        .prepare(`
        SELECT * FROM workflow_runs WHERE run_id = ?
      `)
        .get<RunRow>([id]);

      return rowToRun(updated!);
    },

    async list(
      params?: ListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun>> {
      const limit = params?.pagination?.limit ?? 20;
      const cursor = params?.pagination?.cursor;
      const resolveData = params?.resolveData ?? 'all';

      let query = 'SELECT * FROM workflow_runs WHERE 1=1';
      const queryParams: unknown[] = [];

      if (params?.workflowName) {
        query += ' AND workflow_name = ?';
        queryParams.push(params.workflowName);
      }

      if (params?.status) {
        query += ' AND status = ?';
        queryParams.push(params.status);
      }

      if (cursor) {
        query += ' AND run_id < ?';
        queryParams.push(cursor);
      }

      query += ' ORDER BY run_id DESC LIMIT ?';
      queryParams.push(limit + 1);

      const rows = await db.prepare(query).all<RunRow>(queryParams);
      const hasMore = rows.length > limit;
      const data = rows
        .slice(0, limit)
        .map((row) => filterRunData(rowToRun(row), resolveData));

      return {
        data,
        hasMore,
        cursor: data.at(-1)?.runId ?? null,
      };
    },

    async cancel(id: string, params?): Promise<WorkflowRun> {
      const run = await this.update(id, { status: 'cancelled' });
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(run, resolveData);
    },

    async pause(id: string, params?): Promise<WorkflowRun> {
      const run = await this.update(id, { status: 'paused' });
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(run, resolveData);
    },

    async resume(id: string, params?): Promise<WorkflowRun> {
      const run = await this.update(id, { status: 'running' });
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(run, resolveData);
    },
  };
}

function createStepsStorage(db: BrowserDatabase): Storage['steps'] {
  return {
    async create(runId: string, data: CreateStepRequest): Promise<Step> {
      const now = new Date();
      const nowStr = toSqliteDate(now);

      await db
        .prepare(`
        INSERT INTO workflow_steps (step_id, run_id, step_name, status, input, attempt, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)
      `)
        .run([
          data.stepId,
          runId,
          data.stepName,
          serialize(data.input),
          nowStr,
          nowStr,
        ]);

      return {
        stepId: data.stepId,
        runId,
        stepName: data.stepName,
        status: 'pending',
        input: (data.input as unknown[]) ?? [],
        output: undefined,
        error: undefined,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: undefined,
        completedAt: undefined,
      };
    },

    async get(
      runId: string | undefined,
      stepId: string,
      params?: GetStepParams
    ): Promise<Step> {
      let row: StepRow | undefined;

      if (runId) {
        row = await db
          .prepare(`
          SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ?
        `)
          .get<StepRow>([runId, stepId]);
      } else {
        row = await db
          .prepare(`
          SELECT * FROM workflow_steps WHERE step_id = ?
        `)
          .get<StepRow>([stepId]);
      }

      if (!row) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      const step = rowToStep(row);
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(step, resolveData);
    },

    async update(
      runId: string,
      stepId: string,
      data: UpdateStepRequest
    ): Promise<Step> {
      const existing = await db
        .prepare(`
        SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ?
      `)
        .get<StepRow>([runId, stepId]);

      if (!existing) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      const now = new Date();
      const updates: string[] = ['updated_at = ?'];
      const values: unknown[] = [toSqliteDate(now)];

      if (data.status !== undefined) {
        updates.push('status = ?');
        values.push(data.status);

        if (data.status === 'running' && !existing.started_at) {
          updates.push('started_at = ?');
          values.push(toSqliteDate(now));
        }

        if (data.status === 'completed' || data.status === 'failed') {
          updates.push('completed_at = ?');
          values.push(toSqliteDate(now));
        }
      }

      if (data.output !== undefined) {
        updates.push('output = ?');
        values.push(serialize(data.output));
      }

      if (data.error !== undefined) {
        updates.push('error = ?');
        values.push(serialize(data.error));
      }

      if (data.attempt !== undefined) {
        updates.push('attempt = ?');
        values.push(data.attempt);
      }

      values.push(runId, stepId);

      await db
        .prepare(`
        UPDATE workflow_steps SET ${updates.join(', ')} WHERE run_id = ? AND step_id = ?
      `)
        .run(values);

      const updated = await db
        .prepare(`
        SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ?
      `)
        .get<StepRow>([runId, stepId]);

      return rowToStep(updated!);
    },

    async list(
      params: ListWorkflowRunStepsParams
    ): Promise<PaginatedResponse<Step>> {
      const limit = params.pagination?.limit ?? 20;
      const cursor = params.pagination?.cursor;
      const resolveData = params.resolveData ?? 'all';

      let query = 'SELECT * FROM workflow_steps WHERE run_id = ?';
      const queryParams: unknown[] = [params.runId];

      if (cursor) {
        query += ' AND step_id < ?';
        queryParams.push(cursor);
      }

      query += ' ORDER BY step_id DESC LIMIT ?';
      queryParams.push(limit + 1);

      const rows = await db.prepare(query).all<StepRow>(queryParams);
      const hasMore = rows.length > limit;
      const data = rows
        .slice(0, limit)
        .map((row) => filterStepData(rowToStep(row), resolveData));

      return {
        data,
        hasMore,
        cursor: data.at(-1)?.stepId ?? null,
      };
    },
  };
}

function createEventsStorage(db: BrowserDatabase): Storage['events'] {
  return {
    async create(
      runId: string,
      data: CreateEventRequest,
      params?: CreateEventParams
    ): Promise<Event> {
      const eventId = `evnt_${ulid()}`;
      const now = new Date();

      await db
        .prepare(`
        INSERT INTO workflow_events (event_id, run_id, event_type, correlation_id, event_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .run([
          eventId,
          runId,
          data.eventType,
          data.correlationId ?? null,
          serialize('eventData' in data ? data.eventData : undefined),
          toSqliteDate(now),
        ]);

      const event: Event = {
        eventId,
        runId,
        eventType: data.eventType,
        correlationId: data.correlationId,
        eventData: 'eventData' in data ? data.eventData : undefined,
        createdAt: now,
      } as Event;

      const resolveData = params?.resolveData ?? 'all';
      return filterEventData(event, resolveData);
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params.pagination?.limit ?? 100;
      const cursor = params.pagination?.cursor;
      const sortOrder = params.pagination?.sortOrder ?? 'asc';
      const resolveData = params.resolveData ?? 'all';

      const operator = sortOrder === 'desc' ? '<' : '>';
      const orderDir = sortOrder === 'desc' ? 'DESC' : 'ASC';

      let query = 'SELECT * FROM workflow_events WHERE run_id = ?';
      const queryParams: unknown[] = [params.runId];

      if (cursor) {
        query += ` AND event_id ${operator} ?`;
        queryParams.push(cursor);
      }

      query += ` ORDER BY event_id ${orderDir} LIMIT ?`;
      queryParams.push(limit + 1);

      const rows = await db.prepare(query).all<EventRow>(queryParams);
      const hasMore = rows.length > limit;
      const data = rows
        .slice(0, limit)
        .map((row) => filterEventData(rowToEvent(row), resolveData));

      return {
        data,
        hasMore,
        cursor: data.at(-1)?.eventId ?? null,
      };
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<Event>> {
      const limit = params.pagination?.limit ?? 100;
      const cursor = params.pagination?.cursor;
      const sortOrder = params.pagination?.sortOrder ?? 'asc';
      const resolveData = params.resolveData ?? 'all';

      const operator = sortOrder === 'desc' ? '<' : '>';
      const orderDir = sortOrder === 'desc' ? 'DESC' : 'ASC';

      let query = 'SELECT * FROM workflow_events WHERE correlation_id = ?';
      const queryParams: unknown[] = [params.correlationId];

      if (cursor) {
        query += ` AND event_id ${operator} ?`;
        queryParams.push(cursor);
      }

      query += ` ORDER BY event_id ${orderDir} LIMIT ?`;
      queryParams.push(limit + 1);

      const rows = await db.prepare(query).all<EventRow>(queryParams);
      const hasMore = rows.length > limit;
      const data = rows
        .slice(0, limit)
        .map((row) => filterEventData(rowToEvent(row), resolveData));

      return {
        data,
        hasMore,
        cursor: data.at(-1)?.eventId ?? null,
      };
    },
  };
}

function createHooksStorage(db: BrowserDatabase): Storage['hooks'] {
  return {
    async create(
      runId: string,
      data: CreateHookRequest,
      params?: GetHookParams
    ): Promise<Hook> {
      const now = new Date();

      await db
        .prepare(`
        INSERT INTO workflow_hooks (hook_id, run_id, token, metadata, owner_id, project_id, environment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run([
          data.hookId,
          runId,
          data.token,
          serialize(data.metadata),
          'browser-owner',
          'browser-project',
          'browser',
          toSqliteDate(now),
        ]);

      const hook: Hook = {
        hookId: data.hookId,
        runId,
        token: data.token,
        metadata: data.metadata,
        ownerId: 'browser-owner',
        projectId: 'browser-project',
        environment: 'browser',
        createdAt: now,
      };

      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(hook, resolveData);
    },

    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      const row = await db
        .prepare(`
        SELECT * FROM workflow_hooks WHERE hook_id = ?
      `)
        .get<HookRow>([hookId]);

      if (!row) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }

      const hook = rowToHook(row);
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(hook, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      const row = await db
        .prepare(`
        SELECT * FROM workflow_hooks WHERE token = ?
      `)
        .get<HookRow>([token]);

      if (!row) {
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      }

      const hook = rowToHook(row);
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(hook, resolveData);
    },

    async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
      const limit = params.pagination?.limit ?? 100;
      const cursor = params.pagination?.cursor;
      const resolveData = params.resolveData ?? 'all';

      let query = 'SELECT * FROM workflow_hooks WHERE 1=1';
      const queryParams: unknown[] = [];

      if (params.runId) {
        query += ' AND run_id = ?';
        queryParams.push(params.runId);
      }

      if (cursor) {
        query += ' AND hook_id < ?';
        queryParams.push(cursor);
      }

      query += ' ORDER BY hook_id DESC LIMIT ?';
      queryParams.push(limit + 1);

      const rows = await db.prepare(query).all<HookRow>(queryParams);
      const hasMore = rows.length > limit;
      const data = rows
        .slice(0, limit)
        .map((row) => filterHookData(rowToHook(row), resolveData));

      return {
        data,
        hasMore,
        cursor: data.at(-1)?.hookId ?? null,
      };
    },

    async dispose(hookId: string, params?: GetHookParams): Promise<Hook> {
      const row = await db
        .prepare(`
        SELECT * FROM workflow_hooks WHERE hook_id = ?
      `)
        .get<HookRow>([hookId]);

      if (!row) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }

      await db
        .prepare(`DELETE FROM workflow_hooks WHERE hook_id = ?`)
        .run([hookId]);

      const hook = rowToHook(row);
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(hook, resolveData);
    },
  };
}
