'use server';

import fs from 'node:fs/promises';
import path from 'node:path';
import { hydrateResourceIO } from '@workflow/core/observability';
import {
  createWorld,
  resumeHook as resumeHookRuntime,
  start,
} from '@workflow/core/runtime';
import {
  getDeserializeStream,
  getExternalRevivers,
} from '@workflow/core/serialization';
import { WorkflowAPIError, WorkflowRunNotFoundError } from '@workflow/errors';
import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
  World,
} from '@workflow/world';

/**
 * Environment variable map for world configuration.
 *
 * NOTE: This type is still exported for potential future use cases where
 * dynamic world configuration at runtime may be needed. Currently, the
 * @workflow/web package uses server-side environment variables exclusively
 * and does not pass EnvMap from the client. The server actions still accept
 * this parameter for backwards compatibility and future extensibility.
 */
export type EnvMap = Record<string, string | undefined>;

/**
 * Server configuration info that is safe to send to the client.
 * This deliberately excludes sensitive data like connection strings and auth tokens.
 */
export interface ServerConfig {
  /** Whether the world is configured (WORKFLOW_TARGET_WORLD or default is set) */
  isConfigured: boolean;
  /** Human-readable backend name for display (e.g., "PostgreSQL", "Local", "Vercel") */
  backendDisplayName: string;
  /** The raw backend identifier (e.g., "@workflow/world-postgres", "local", "vercel") */
  backendId: string;
  /** Non-sensitive display info specific to the backend type */
  displayInfo: {
    /** For Vercel: the environment (production/preview) */
    environment?: string;
    /** For Vercel: the project name (not ID) */
    projectName?: string;
    /** For Vercel: the team name (not ID) */
    teamName?: string;
    /** For Postgres: just the hostname (no credentials or full URL) */
    hostname?: string;
    /** For Postgres: the database name */
    database?: string;
    /** For Local: the data directory path */
    dataDir?: string;
  };
}

/**
 * Map from WORKFLOW_TARGET_WORLD value to human-readable display name
 */
function getBackendDisplayName(targetWorld: string | undefined): string {
  if (!targetWorld) return 'Local';
  switch (targetWorld) {
    case 'local':
      return 'Local';
    case 'vercel':
      return 'Vercel';
    case '@workflow/world-postgres':
    case 'postgres':
      return 'PostgreSQL';
    default:
      // For custom worlds, try to make a readable name
      if (targetWorld.startsWith('@')) {
        // Extract package name without scope for display
        const parts = targetWorld.split('/');
        return parts[parts.length - 1] || targetWorld;
      }
      return targetWorld;
  }
}

/**
 * Extract hostname from a database URL without exposing credentials.
 */
function extractHostnameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract database name from a postgres URL.
 */
function extractDatabaseFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    // pathname is like "/dbname", so remove leading slash
    const dbName = parsed.pathname?.slice(1);
    return dbName || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shorten a file path for display purposes.
 * - Replaces home directory with ~
 * - If path is still long, shows .../last-two-segments
 */
function shortenPath(filePath: string): string {
  if (!filePath) return filePath;

  let shortened = filePath;

  // Replace home directory with ~
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir && shortened.startsWith(homeDir)) {
    shortened = '~' + shortened.slice(homeDir.length);
  }

  // If still long (> 40 chars), abbreviate to show last meaningful segments
  if (shortened.length > 40) {
    const segments = shortened.split('/').filter(Boolean);
    if (segments.length > 2) {
      // Show .../<parent>/<name>
      const lastTwo = segments.slice(-2).join('/');
      shortened = '.../' + lastTwo;
    }
  }

  return shortened;
}

/**
 * Build an EnvMap from server environment variables.
 * Used internally by getWorldFromEnv when no client EnvMap is provided
 * or when using environment-based configuration.
 */
function buildEnvMapFromProcessEnv(): EnvMap {
  return {
    WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD,
    WORKFLOW_VERCEL_ENV: process.env.WORKFLOW_VERCEL_ENV,
    WORKFLOW_VERCEL_AUTH_TOKEN: process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
    WORKFLOW_VERCEL_PROJECT: process.env.WORKFLOW_VERCEL_PROJECT,
    WORKFLOW_VERCEL_TEAM: process.env.WORKFLOW_VERCEL_TEAM,
    PORT: process.env.PORT,
    WORKFLOW_MANIFEST_PATH: process.env.WORKFLOW_MANIFEST_PATH,
    WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR,
    WORKFLOW_POSTGRES_URL: process.env.WORKFLOW_POSTGRES_URL,
  };
}

/**
 * Get server configuration info that is safe to send to the client.
 *
 * This returns display-only information about the current world configuration
 * without exposing sensitive data like connection strings or auth tokens.
 * The web UI uses this to show the current connection status.
 */
export async function getServerConfig(): Promise<ServerConfig> {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;

  // Determine the effective backend
  // Default behavior matches createWorld: vercel if VERCEL_DEPLOYMENT_ID is set, else local
  let effectiveBackend = targetWorld;
  if (!effectiveBackend) {
    effectiveBackend = process.env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local';
  }

  const backendDisplayName = getBackendDisplayName(effectiveBackend);
  const displayInfo: ServerConfig['displayInfo'] = {};

  // Populate non-sensitive display info based on backend type
  if (
    effectiveBackend === 'vercel' ||
    effectiveBackend === '@workflow/world-vercel'
  ) {
    displayInfo.environment = process.env.WORKFLOW_VERCEL_ENV || 'production';
    // Note: We show the IDs as-is since they're not sensitive
    // In a future enhancement, we could resolve these to actual names via Vercel API
    displayInfo.projectName = process.env.WORKFLOW_VERCEL_PROJECT;
    displayInfo.teamName = process.env.WORKFLOW_VERCEL_TEAM;
  } else if (
    effectiveBackend === '@workflow/world-postgres' ||
    effectiveBackend === 'postgres'
  ) {
    const postgresUrl = process.env.WORKFLOW_POSTGRES_URL;
    displayInfo.hostname = extractHostnameFromUrl(postgresUrl);
    displayInfo.database = extractDatabaseFromUrl(postgresUrl);
  } else if (
    effectiveBackend === 'local' ||
    effectiveBackend === '@workflow/world-local'
  ) {
    displayInfo.dataDir = shortenPath(
      process.env.WORKFLOW_LOCAL_DATA_DIR || '.workflow-data'
    );
  }

  return {
    isConfigured: true,
    backendDisplayName,
    backendId: effectiveBackend,
    displayInfo,
  };
}

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
  // "Server" if the error originates in this file, "API" if the error originates in the World interface
  layer: 'server' | 'API';
  cause?: string;
  request?: {
    operation: string;
    params: Record<string, any>;
    status?: number;
    url?: string;
    code?: string;
  };
}

/**
 * Result wrapper for server actions that can return either data or error
 */
export type ServerActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: ServerActionError };

/**
 * Cache for World instances keyed by envMap.
 *
 * When using server-side environment variables (the recommended approach),
 * there will typically only be one cached World instance since the env config
 * doesn't change at runtime.
 *
 * The cache key is derived from the effective EnvMap to support potential
 * future use cases where dynamic world switching may be needed.
 */
const worldCache = new Map<string, World>();

/**
 * Get or create a World instance based on configuration.
 *
 * Configuration priority:
 * 1. If server-side environment variables are set (WORKFLOW_TARGET_WORLD, etc.),
 *    those are used and the envMap parameter is ignored. This is the standard
 *    mode used by the @workflow/web package.
 *
 * 2. If no server-side env vars are set but envMap is provided, the envMap
 *    values are used. This mode is reserved for future use cases where
 *    dynamic world configuration at runtime may be needed (e.g., a multi-tenant
 *    observability dashboard).
 *
 * 3. If neither is set, createWorld() falls back to its default behavior
 *    (vercel if VERCEL_DEPLOYMENT_ID is set, otherwise local).
 *
 * @param envMap - Optional environment map for dynamic configuration (reserved for future use)
 */
function getWorldFromEnv(envMap: EnvMap) {
  // Determine the effective configuration to use
  // Priority: server env vars > provided envMap > defaults
  const serverEnvMap = buildEnvMapFromProcessEnv();
  const hasServerConfig = Object.values(serverEnvMap).some(
    (v) => v !== undefined && v !== ''
  );

  const effectiveEnvMap = hasServerConfig ? serverEnvMap : envMap;

  // Generate stable cache key from envMap
  const sortedKeys = Object.keys(effectiveEnvMap).sort();
  const sortedEntries = sortedKeys.map((key) => [key, effectiveEnvMap[key]]);
  const cacheKey = JSON.stringify(Object.fromEntries(sortedEntries));

  // Check if we have a cached World for this configuration
  const cachedWorld = worldCache.get(cacheKey);
  if (cachedWorld) {
    return cachedWorld;
  }

  // No cached World found, set environment variables and create a new one
  for (const [key, value] of Object.entries(effectiveEnvMap)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    process.env[key] = value;
  }

  const world = createWorld();

  // Cache the newly created World
  worldCache.set(cacheKey, world);

  return world;
}

/**
 * Creates a structured error object from a caught error
 */
function createServerActionError<T>(
  error: unknown,
  operation: string,
  requestParams?: Record<string, any>
): ServerActionResult<T> {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`[web-api] ${operation} error:`, err);
  let errorResponse: ServerActionError;

  console.warn('isWorkflowAPIError(error)', WorkflowAPIError.is(error));
  console.warn(
    'error.status',
    WorkflowAPIError.is(error) ? error.status : undefined
  );
  console.warn('error.url', WorkflowAPIError.is(error) ? error.url : undefined);
  console.warn(
    'error.code',
    WorkflowAPIError.is(error) ? error.code : undefined
  );

  if (WorkflowAPIError.is(error)) {
    // If the World threw the error on fetch/fs.read, we add that data
    // to the error object
    errorResponse = {
      message: getUserFacingErrorMessage(err, error.status),
      layer: 'API',
      cause: err.stack || err.message,
      request: {
        operation,
        params: requestParams ?? {},
        status: error.status,
        url: error.url,
        code: error.code ?? undefined,
      },
    };
  } else if (WorkflowRunNotFoundError.is(error)) {
    // The World might repackage the error as a WorkflowRunNotFoundError
    errorResponse = {
      message: getUserFacingErrorMessage(error, 404),
      layer: 'API',
      cause: err.stack || err.message,
      request: { operation, status: 404, params: requestParams ?? {} },
    };
  } else {
    errorResponse = {
      message: getUserFacingErrorMessage(err),
      layer: 'server',
      cause: err.stack || err.message,
      request: { status: 500, operation, params: requestParams ?? {} },
    };
  }

  return {
    success: false,
    error: errorResponse,
  };
}

/**
 * Converts an error into a user-facing message
 */
function getUserFacingErrorMessage(error: Error, status?: number): string {
  console.warn('getUserFacingErrorMessage', error, status);
  if (!status) {
    console.warn('No status, returning error message', error.message);
    return 'Error creating response: ' + error.message;
  }

  // Check for common error patterns
  if (status === 403 || status === 401) {
    return 'Access denied. Please check your credentials and permissions.';
  }

  if (status === 404) {
    return 'The requested resource was not found.';
  }

  if (status === 500) {
    return 'Error connecting to World backend, please try again later.';
  }

  if (error.message?.includes('Network') || error.message?.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }

  // Return the original message for other errors
  return error.message || 'An unexpected error occurred';
}

const toJSONCompatible = <T>(data: T): T => {
  if (data && typeof data === 'object') {
    return JSON.parse(JSON.stringify(data)) as T;
  }
  return data;
};

const hydrate = <T>(data: T): T => {
  data = toJSONCompatible(data);
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
  data = toJSONCompatible(data);
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
    return createServerActionError<PaginatedResult<WorkflowRun>>(
      error,
      'world.runs.list',
      params
    );
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
    return createResponse(hydratedRun);
  } catch (error) {
    return createServerActionError<WorkflowRun>(error, 'world.runs.get', {
      runId,
      resolveData,
    });
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
    return createServerActionError<PaginatedResult<Step>>(
      error,
      'world.steps.list',
      {
        runId,
        ...params,
      }
    );
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
    const hydratedStep = hydrate(step as Step);
    return createResponse(hydratedStep);
  } catch (error) {
    return createServerActionError<Step>(error, 'world.steps.get', {
      runId,
      stepId,
      resolveData,
    });
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
    return createServerActionError<PaginatedResult<Event>>(
      error,
      'world.events.list',
      {
        runId,
        ...params,
      }
    );
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
      data: result.data.map(hydrate),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<Event>>(
      error,
      'world.events.listByCorrelationId',
      {
        correlationId,
        ...params,
      }
    );
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
    return createServerActionError<PaginatedResult<Hook>>(
      error,
      'world.hooks.list',
      params
    );
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
    return createServerActionError<Hook>(error, 'world.hooks.get', {
      hookId,
      resolveData,
    });
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
    return createServerActionError<void>(error, 'world.runs.cancel', { runId });
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
    return createServerActionError<string>(error, 'recreateRun', { runId });
  }
}

/**
 * Re-enqueue a workflow run.
 *
 * This re-enqueues the workflow orchestration layer. It's a no-op unless the workflow
 * got stuck due to an implementation issue in the World. Useful for debugging custom Worlds.
 */
export async function reenqueueRun(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<void>> {
  try {
    const world = getWorldFromEnv({ ...worldEnv });
    const run = await world.runs.get(runId);
    const deploymentId = run.deploymentId;

    await world.queue(
      `__wkf_workflow_${run.workflowName}`,
      {
        runId,
      },
      {
        deploymentId,
      }
    );

    return createResponse(undefined);
  } catch (error) {
    return createServerActionError<void>(error, 'reenqueueRun', { runId });
  }
}

export interface StopSleepResult {
  /** Number of pending sleeps that were stopped */
  stoppedCount: number;
}

export interface StopSleepOptions {
  /**
   * Optional list of specific correlation IDs to target.
   * If provided, only these sleep calls will be interrupted.
   * If not provided, all pending sleep calls will be interrupted.
   */
  correlationIds?: string[];
}

/**
 * Wake up a workflow run by interrupting pending sleep() calls.
 *
 * This finds wait_created events without matching wait_completed events,
 * creates wait_completed events for them, and then re-enqueues the run.
 *
 * @param worldEnv - Environment configuration for the World
 * @param runId - The run ID to wake up
 * @param options - Optional settings to narrow down targeting (specific correlation IDs)
 */
export async function wakeUpRun(
  worldEnv: EnvMap,
  runId: string,
  options?: StopSleepOptions
): Promise<ServerActionResult<StopSleepResult>> {
  try {
    const world = getWorldFromEnv({ ...worldEnv });
    const run = await world.runs.get(runId);
    const deploymentId = run.deploymentId;

    // Fetch all events for the run
    const eventsResult = await world.events.list({
      runId,
      pagination: { limit: 1000 },
      resolveData: 'none',
    });

    // Find wait_created events without matching wait_completed events
    const waitCreatedEvents = eventsResult.data.filter(
      (e) => e.eventType === 'wait_created'
    );
    const waitCompletedCorrelationIds = new Set(
      eventsResult.data
        .filter((e) => e.eventType === 'wait_completed')
        .map((e) => e.correlationId)
    );

    let pendingWaits = waitCreatedEvents.filter(
      (e) => !waitCompletedCorrelationIds.has(e.correlationId)
    );

    // If specific correlation IDs are provided, filter to only those
    if (options?.correlationIds && options.correlationIds.length > 0) {
      const targetCorrelationIds = new Set(options.correlationIds);
      pendingWaits = pendingWaits.filter(
        (e) => e.correlationId && targetCorrelationIds.has(e.correlationId)
      );
    }

    // Create wait_completed events for each pending wait
    for (const waitEvent of pendingWaits) {
      if (waitEvent.correlationId) {
        await world.events.create(runId, {
          eventType: 'wait_completed',
          correlationId: waitEvent.correlationId,
        });
      }
    }

    // Re-enqueue the run to wake it up
    if (pendingWaits.length > 0) {
      await world.queue(
        `__wkf_workflow_${run.workflowName}`,
        {
          runId,
        },
        {
          deploymentId,
        }
      );
    }

    return createResponse({ stoppedCount: pendingWaits.length });
  } catch (error) {
    return createServerActionError<StopSleepResult>(error, 'wakeUpRun', {
      runId,
      correlationIds: options?.correlationIds,
    });
  }
}

export interface ResumeHookResult {
  /** The hook ID that was resumed */
  hookId: string;
  /** The run ID associated with the hook */
  runId: string;
}

/**
 * Resume a hook by sending a payload.
 *
 * This sends a payload to a hook identified by its token, which resumes
 * the associated workflow run. The payload will be available as the return
 * value of the `createHook()` call in the workflow.
 *
 * @param worldEnv - Environment configuration for the World
 * @param token - The hook token
 * @param payload - The JSON payload to send to the hook
 */
export async function resumeHook(
  worldEnv: EnvMap,
  token: string,
  payload: unknown
): Promise<ServerActionResult<ResumeHookResult>> {
  try {
    // Initialize the world so resumeHookRuntime can access it
    getWorldFromEnv({ ...worldEnv });

    const hook = await resumeHookRuntime(token, payload);

    return createResponse({
      hookId: hook.hookId,
      runId: hook.runId,
    });
  } catch (error) {
    return createServerActionError<ResumeHookResult>(error, 'resumeHook', {
      token,
    });
  }
}

export async function readStreamServerAction(
  env: EnvMap,
  streamId: string,
  startIndex?: number
): Promise<ReadableStream<unknown> | ServerActionError> {
  try {
    const world = getWorldFromEnv(env);
    // We should probably use getRun().getReadable() instead, to make the UI
    // more consistent with runtime behavior, and also expose a "replay" and "startIndex",
    // feature, to allow for testing World behavior.
    const stream = await world.readFromStream(streamId, startIndex);

    const revivers = getExternalRevivers(globalThis, [], '');
    const transform = getDeserializeStream(revivers);

    return stream.pipeThrough(transform);
  } catch (error) {
    const actionError = createServerActionError(error, 'world.readFromStream', {
      streamId,
      startIndex,
    });
    if (!actionError.success) {
      return actionError.error;
    }
    // Shouldn't happen, this is just a type guard
    throw new Error();
  }
}

/**
 * List all stream IDs for a run
 */
export async function fetchStreams(
  env: EnvMap,
  runId: string
): Promise<ServerActionResult<string[]>> {
  try {
    const world = getWorldFromEnv(env);
    const streams = await world.listStreamsByRunId(runId);
    return createResponse(streams);
  } catch (error) {
    return createServerActionError<string[]>(
      error,
      'world.listStreamsByRunId',
      {
        runId,
      }
    );
  }
}

/**
 * Fetch the workflows manifest from the workflow route directory
 * The manifest is generated at build time and contains static structure info about workflows
 *
 * Configuration priority:
 * 1. WORKFLOW_MANIFEST_PATH - explicit path to the manifest file
 * 2. Standard Next.js app router locations (app/.well-known/workflow/v1/manifest.json)
 * 3. WORKFLOW_EMBEDDED_DATA_DIR - legacy data directory
 */
export async function fetchWorkflowsManifest(
  worldEnv: EnvMap
): Promise<ServerActionResult<any>> {
  const cwd = process.cwd();

  console.log('[fetchWorkflowsManifest] cwd:', cwd);
  console.log(
    '[fetchWorkflowsManifest] WORKFLOW_MANIFEST_PATH from env:',
    worldEnv.WORKFLOW_MANIFEST_PATH
  );

  // Helper to resolve path (absolute or relative to cwd)
  const resolvePath = (p: string) =>
    path.isAbsolute(p) ? p : path.join(cwd, p);

  // Build list of paths to try, in priority order
  const manifestPaths: string[] = [];

  // 1. Explicit manifest path configuration (highest priority)
  if (worldEnv.WORKFLOW_MANIFEST_PATH) {
    manifestPaths.push(resolvePath(worldEnv.WORKFLOW_MANIFEST_PATH));
  }
  if (process.env.WORKFLOW_MANIFEST_PATH) {
    manifestPaths.push(resolvePath(process.env.WORKFLOW_MANIFEST_PATH));
  }

  // 2. Standard Next.js app router locations
  manifestPaths.push(
    path.join(cwd, 'app/.well-known/workflow/v1/manifest.json'),
    path.join(cwd, 'src/app/.well-known/workflow/v1/manifest.json')
  );

  // 3. Legacy data directory locations
  if (worldEnv.WORKFLOW_EMBEDDED_DATA_DIR) {
    manifestPaths.push(
      path.join(
        resolvePath(worldEnv.WORKFLOW_EMBEDDED_DATA_DIR),
        'manifest.json'
      )
    );
  }
  if (process.env.WORKFLOW_EMBEDDED_DATA_DIR) {
    manifestPaths.push(
      path.join(
        resolvePath(process.env.WORKFLOW_EMBEDDED_DATA_DIR),
        'manifest.json'
      )
    );
  }

  console.log('[fetchWorkflowsManifest] Trying paths:', manifestPaths);

  // Try each path until we find the manifest
  for (const manifestPath of manifestPaths) {
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      const workflowCount = Object.keys(manifest.workflows || {}).reduce(
        (acc, filePath) =>
          acc + Object.keys(manifest.workflows[filePath] || {}).length,
        0
      );
      console.log(
        `[fetchWorkflowsManifest] Found manifest at: ${manifestPath} with ${workflowCount} workflows`
      );
      return createResponse(manifest);
    } catch (err) {
      console.log(
        `[fetchWorkflowsManifest] Failed to read: ${manifestPath}`,
        (err as Error).message
      );
      // Continue to next path
    }
  }

  // If no manifest found, return an empty manifest
  // This allows the UI to work without workflows graph data
  console.log('[fetchWorkflowsManifest] No manifest found, returning empty');
  return createResponse({
    version: '1.0.0',
    steps: {},
    workflows: {},
  });
}
