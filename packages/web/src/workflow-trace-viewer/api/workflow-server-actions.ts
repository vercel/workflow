'use server';

import { hydrateResourceIO } from '@workflow/core/observability';
import { createWorld } from '@workflow/core/runtime';
import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
} from '@workflow/world';

export type EnvMap = Record<string, string | undefined>;

export interface PaginatedResult<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

function getWorldFromEnv(envMap: EnvMap) {
  for (const [key, value] of Object.entries(envMap)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    process.env[key] = value;
  }
  return createWorld();
}

/**
 * Fetch paginated list of workflow runs
 */
export async function fetchRuns(
  worldEnv: EnvMap,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    workflowName?: string;
    status?: WorkflowRunStatus;
  }
): Promise<PaginatedResult<WorkflowRun>> {
  const {
    cursor,
    sortOrder = 'desc',
    limit = 10,
    workflowName,
    status,
  } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.runs.list({
      ...(workflowName ? { workflowName } : {}),
      ...(status ? { status: status } : {}),
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return {
      data: (result.data as unknown as WorkflowRun[]).map(hydrateResourceIO),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    };
  } catch (error) {
    console.error('Failed to fetch runs:', error);
    throw error;
  }
}

/**
 * Fetch a single workflow run with full data
 */
export async function fetchRun(
  worldEnv: EnvMap,
  runId: string
): Promise<WorkflowRun> {
  try {
    const world = getWorldFromEnv(worldEnv);
    const run = await world.runs.get(runId, { resolveData: 'all' });
    return hydrateResourceIO(run as WorkflowRun);
  } catch (error) {
    console.error('Failed to fetch run:', error);
    throw error;
  }
}

/**
 * Fetch paginated list of steps for a run
 */
export async function fetchSteps(
  worldEnv: EnvMap,
  runId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<PaginatedResult<Step>> {
  const { cursor, sortOrder = 'asc', limit = 100 } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.steps.list({
      runId,
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return {
      data: (result.data as Step[]).map(hydrateResourceIO),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    };
  } catch (error) {
    console.error('Failed to fetch steps:', error);
    throw error;
  }
}

/**
 * Fetch a single step with full data
 */
export async function fetchStep(
  worldEnv: EnvMap,
  runId: string,
  stepId: string
): Promise<Step> {
  try {
    const world = getWorldFromEnv(worldEnv);
    const step = await world.steps.get(runId, stepId, { resolveData: 'all' });
    return hydrateResourceIO(step as Step);
  } catch (error) {
    console.error('Failed to fetch step:', error);
    throw error;
  }
}

/**
 * Fetch paginated list of events for a run
 */
export async function fetchEvents(
  worldEnv: EnvMap,
  runId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<PaginatedResult<Event>> {
  const { cursor, sortOrder = 'asc', limit = 1000 } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.events.list({
      runId,
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return {
      data: result.data as unknown as Event[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    };
  } catch (error) {
    console.error('Failed to fetch events:', error);
    throw error;
  }
}

/**
 * Fetch events by correlation ID
 */
export async function fetchEventsByCorrelationId(
  worldEnv: EnvMap,
  correlationId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    withData?: boolean;
  }
): Promise<PaginatedResult<Event>> {
  const { cursor, sortOrder = 'asc', limit = 1000, withData = false } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.events.listByCorrelationId({
      correlationId,
      pagination: { cursor, limit, sortOrder },
      resolveData: withData ? 'all' : 'none',
    });
    return {
      data: result.data as unknown as Event[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    };
  } catch (error) {
    console.error('Failed to fetch events by correlation ID:', error);
    throw error;
  }
}

/**
 * Fetch paginated list of hooks
 */
export async function fetchHooks(
  worldEnv: EnvMap,
  params: {
    runId?: string;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<PaginatedResult<Hook>> {
  const { runId, cursor, sortOrder = 'desc', limit = 10 } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.hooks.list({
      ...(runId ? { runId } : {}),
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return {
      data: (result.data as Hook[]).map(hydrateResourceIO),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    };
  } catch (error) {
    console.error('Failed to fetch hooks:', error);
    throw error;
  }
}

/**
 * Fetch a single hook with full data
 */
export async function fetchHook(
  worldEnv: EnvMap,
  hookId: string
): Promise<Hook> {
  try {
    const world = getWorldFromEnv(worldEnv);
    const hook = await world.hooks.get(hookId, { resolveData: 'all' });
    return hydrateResourceIO(hook as Hook);
  } catch (error) {
    console.error('Failed to fetch hook:', error);
    throw error;
  }
}

/**
 * Cancel a workflow run
 */
export async function cancelRun(worldEnv: EnvMap, runId: string) {
  try {
    const world = getWorldFromEnv(worldEnv);
    await world.runs.cancel(runId);
  } catch (error) {
    console.error('Failed to cancel run:', error);
    throw error;
  }
}

export async function readStreamServerAction(
  env: EnvMap,
  streamId: string,
  startIndex?: number
): Promise<ReadableStream<Uint8Array>> {
  const world = getWorldFromEnv(env);
  return world.readFromStream(streamId, startIndex);
}
