'use server';

import { hydrateResourceIO } from '@workflow/core/observability';
import { createWorld, start } from '@workflow/core/runtime';
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

/**
 * Structured error information that can be sent to the client
 */
export interface ServerActionError {
  message: string;
  layer: 'server' | 'API';
  cause?: string;
  request?: {
    operation: string;
    params: Record<string, any>;
  };
}

/**
 * Result wrapper for server actions that can return either data or error
 */
export type ServerActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: ServerActionError };

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
 * Creates a structured error object from a caught error
 */
function createServerActionError(
  error: unknown,
  operation: string,
  params?: Record<string, any>
): ServerActionError {
  const err = error instanceof Error ? error : new Error(String(error));

  // Determine if this is an API layer error (from the World interface)
  // or a server layer error (from within the server action)
  const isAPIError =
    err.message?.includes('fetch') ||
    err.message?.includes('HTTP') ||
    err.message?.includes('network');

  const actionError: ServerActionError = {
    message: getUserFacingMessage(err),
    layer: isAPIError ? 'API' : 'server',
    cause: err.stack || err.message,
    request: params ? { operation, params } : undefined,
  };
  return actionError;
}

/**
 * Converts an error into a user-facing message
 */
function getUserFacingMessage(error: Error): string {
  // Check for common error patterns
  if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
    return 'Access denied. Please check your credentials and permissions.';
  }

  if (error.message?.includes('404') || error.message?.includes('Not Found')) {
    return 'The requested resource was not found.';
  }

  if (
    error.message?.includes('500') ||
    error.message?.includes('Internal Server Error')
  ) {
    return 'An internal server error occurred. Please try again later.';
  }

  if (error.message?.includes('Network') || error.message?.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }

  // Return the original message for other errors
  return error.message || 'An unexpected error occurred';
}

const hydrate = <T>(data: T): T => {
  try {
    return hydrateResourceIO(data as any) as T;
  } catch (error) {
    throw new Error('Failed to hydrate data', { cause: error });
  }
};

/**
 * Helper to create successful responses
 * @param data - The data to return on success
 * @returns ServerActionResult with success=true and the data
 */
function createResponse<T>(data: T): ServerActionResult<T> {
  return {
    success: true,
    data,
  };
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
): Promise<ServerActionResult<PaginatedResult<WorkflowRun>>> {
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
    return createResponse({
      data: (result.data as unknown as WorkflowRun[]).map(hydrate),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    console.error('Failed to fetch runs:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.runs.list', params),
    };
  }
}

/**
 * Fetch a single workflow run with full data
 */
export async function fetchRun(
  worldEnv: EnvMap,
  runId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<WorkflowRun>> {
  try {
    const world = getWorldFromEnv(worldEnv);
    const run = await world.runs.get(runId, { resolveData });
    const hydratedRun = hydrate(run as WorkflowRun);
    console.log('hydratedRun', hydratedRun.input);
    return createResponse(hydratedRun);
  } catch (error) {
    console.error('Failed to fetch run:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.runs.get', {
        runId,
        resolveData,
      }),
    };
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
): Promise<ServerActionResult<PaginatedResult<Step>>> {
  const { cursor, sortOrder = 'asc', limit = 100 } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.steps.list({
      runId,
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return createResponse({
      data: (result.data as Step[]).map(hydrate),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    console.error('Failed to fetch steps:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.steps.list', {
        runId,
        ...params,
      }),
    };
  }
}

/**
 * Fetch a single step with full data
 */
export async function fetchStep(
  worldEnv: EnvMap,
  runId: string,
  stepId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<Step>> {
  try {
    const world = getWorldFromEnv(worldEnv);
    const step = await world.steps.get(runId, stepId, { resolveData });
    return createResponse(hydrate(step as Step));
  } catch (error) {
    console.error('Failed to fetch step:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.steps.get', {
        runId,
        stepId,
        resolveData,
      }),
    };
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
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  const { cursor, sortOrder = 'asc', limit = 1000 } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.events.list({
      runId,
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return createResponse({
      data: result.data as unknown as Event[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.events.list', {
        runId,
        ...params,
      }),
    };
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
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  const { cursor, sortOrder = 'asc', limit = 1000, withData = false } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.events.listByCorrelationId({
      correlationId,
      pagination: { cursor, limit, sortOrder },
      resolveData: withData ? 'all' : 'none',
    });
    return createResponse({
      data: result.data as unknown as Event[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    console.error('Failed to fetch events by correlation ID:', error);
    return {
      success: false,
      error: createServerActionError(
        error,
        'world.events.listByCorrelationId',
        { correlationId, ...params }
      ),
    };
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
): Promise<ServerActionResult<PaginatedResult<Hook>>> {
  const { runId, cursor, sortOrder = 'desc', limit = 10 } = params;
  try {
    const world = getWorldFromEnv(worldEnv);
    const result = await world.hooks.list({
      ...(runId ? { runId } : {}),
      pagination: { cursor, limit, sortOrder },
      resolveData: 'none',
    });
    return createResponse({
      data: (result.data as Hook[]).map(hydrate),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    console.error('Failed to fetch hooks:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.hooks.list', params),
    };
  }
}

/**
 * Fetch a single hook with full data
 */
export async function fetchHook(
  worldEnv: EnvMap,
  hookId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<Hook>> {
  try {
    const world = getWorldFromEnv(worldEnv);
    const hook = await world.hooks.get(hookId, { resolveData });
    return createResponse(hydrate(hook as Hook));
  } catch (error) {
    console.error('Failed to fetch hook:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.hooks.get', {
        hookId,
        resolveData,
      }),
    };
  }
}

/**
 * Cancel a workflow run
 */
export async function cancelRun(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<void>> {
  try {
    const world = getWorldFromEnv(worldEnv);
    await world.runs.cancel(runId);
    return createResponse(undefined);
  } catch (error) {
    console.error('Failed to cancel run:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.runs.cancel', { runId }),
    };
  }
}

/**
 * Start a new workflow run.
 *
 * This requires the ID of an existing run of which to re-use the deployment ID of.
 */
export async function recreateRun(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<string>> {
  try {
    const world = getWorldFromEnv({ ...worldEnv });
    const run = await world.runs.get(runId);
    const hydratedRun = hydrate(run as WorkflowRun);
    const deploymentId = run.deploymentId;
    const newRun = await start(
      { workflowId: run.workflowName },
      hydratedRun.input,
      {
        deploymentId,
      }
    );
    return createResponse(newRun.runId);
  } catch (error) {
    console.error('Failed to start run:', error);
    return {
      success: false,
      error: createServerActionError(error, 'recreateRun', { runId }),
    };
  }
}

export async function readStreamServerAction(
  env: EnvMap,
  streamId: string,
  startIndex?: number
): Promise<ServerActionResult<ReadableStream<Uint8Array>>> {
  try {
    const world = getWorldFromEnv(env);
    const stream = await world.readFromStream(streamId, startIndex);
    return createResponse(stream);
  } catch (error) {
    console.error('Failed to read stream:', error);
    return {
      success: false,
      error: createServerActionError(error, 'world.readFromStream', {
        streamId,
        startIndex,
      }),
    };
  }
}
