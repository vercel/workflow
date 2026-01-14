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
import { findWorkflowDataDir } from '@workflow/utils/check-data-dir';
import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
  World,
} from '@workflow/world';
import { createVercelWorld } from '@workflow/world-vercel';

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

export interface PublicDbUriInfo {
  /** Name of the WORKFLOW_* env var that contained the URI */
  key: string;
  /** URL protocol without the trailing ":" (e.g. "postgres", "mongodb", "redis") */
  protocol: string;
  /** Sanitized hostname (no credentials) */
  hostname?: string;
  /** Sanitized database name if derivable from the URI (e.g. pathname) */
  database?: string;
}

/**
 * Public configuration info that is safe to send to the client.
 *
 * IMPORTANT:
 * - The web UI must not be able to read arbitrary server env vars.
 * - The only env-derived data we expose is from a strict per-world allowlist.
 */
export interface PublicServerConfig {
  /** Human-readable backend name for display (e.g., "PostgreSQL", "Local", "Vercel") */
  backendDisplayName: string;
  /** The raw backend identifier (e.g., "@workflow/world-postgres", "local", "vercel") */
  backendId: string;
  /**
   * Sanitized DB URI hints, derived from WORKFLOW_* vars that look like DB URIs.
   * This is safe to show because it contains no credentials.
   */
  publicDbUris?: PublicDbUriInfo[];
  /** Safe, whitelisted, env-derived values (varies by backend) */
  publicEnv:
    | {
        kind: 'vercel';
        /** teamId/teamSlug (whichever WORKFLOW_VERCEL_TEAM is set to) */
        teamId?: string;
        /** projectId/projectName (whichever WORKFLOW_VERCEL_PROJECT is set to) */
        projectId?: string;
        environment?: string;
      }
    | {
        kind: 'local';
        /**
         * Next.js server port (useful when self-hosting or reverse proxying).
         * Note: This is NOT the workflow app port; it's the web UI server port.
         */
        port?: string;
        /**
         * Absolute path to the workflow data directory if it exists.
         * This is safe to show, but UIs should prefer displaying shortName.
         */
        dataDirPath?: string;
        /** Absolute path to the project directory (best-effort) */
        projectDir: string;
        /** Short display name derived from projectDir */
        shortName: string;
      }
    | {
        kind: 'postgres';
      }
    | {
        kind: 'custom';
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

function getEffectiveBackendId(): string {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  if (targetWorld) {
    return targetWorld;
  }
  // Match @workflow/core/runtime defaulting: vercel if VERCEL_DEPLOYMENT_ID is set, else local.
  return process.env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local';
}

function getObservabilityCwd(): string {
  const raw = process.env.WORKFLOW_OBSERVABILITY_CWD;
  if (!raw) {
    return process.cwd();
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
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
 * Extract database name from a URL where pathname is like "/dbname".
 * (Works for postgres/mongodb-style URLs; returns undefined when not applicable.)
 */
function extractDatabaseFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const dbName = parsed.pathname?.slice(1);
    return dbName || undefined;
  } catch {
    return undefined;
  }
}

const KNOWN_DB_URI_ENV_KEYS = new Set<string>([
  // Official
  'WORKFLOW_POSTGRES_URL',
  // Community (from worlds-manifest.json)
  'WORKFLOW_TURSO_DATABASE_URL',
  'WORKFLOW_MONGODB_URI',
  'WORKFLOW_REDIS_URI',
]);

function looksLikeDbUriEnvKey(key: string): boolean {
  return KNOWN_DB_URI_ENV_KEYS.has(key) || /_(URL|URI)$/.test(key);
}

function collectPublicDbUris(): PublicDbUriInfo[] {
  const entries = Object.entries(process.env).filter(([key, value]) => {
    if (!key.startsWith('WORKFLOW_')) return false;
    if (!looksLikeDbUriEnvKey(key)) return false;
    if (!value) return false;
    // Quick prefilter: require some scheme-like content
    return value.includes(':');
  });

  const results: PublicDbUriInfo[] = [];
  for (const [key, value] of entries) {
    try {
      const parsed = new URL(value as string);
      const protocol = (parsed.protocol || '').replace(':', '');
      // Skip file-based DB URIs: hostname is empty and not useful for UI.
      if (protocol === 'file') continue;
      const hostname = extractHostnameFromUrl(value);
      const database = extractDatabaseFromUrl(value);
      // If we can't even derive a hostname, don't include the entry.
      if (!hostname) continue;
      results.push({ key, protocol, hostname, database });
    } catch {
      // Not a parseable URL; ignore.
    }
  }

  return results;
}

/**
 * Get public configuration info that is safe to send to the client.
 *
 * This is the ONLY server action that intentionally exposes env-derived data,
 * and that data is strictly whitelisted per world backend.
 */
export async function getPublicServerConfig(): Promise<PublicServerConfig> {
  const backendId = getEffectiveBackendId();
  const backendDisplayName = getBackendDisplayName(backendId);
  const publicDbUris = collectPublicDbUris();
  const withDbUris = publicDbUris.length > 0 ? { publicDbUris } : {};

  // Whitelist public env vars by backend.
  if (backendId === 'vercel' || backendId === '@workflow/world-vercel') {
    return {
      backendDisplayName,
      backendId,
      ...withDbUris,
      publicEnv: {
        kind: 'vercel',
        environment: process.env.WORKFLOW_VERCEL_ENV || 'production',
        projectId: process.env.WORKFLOW_VERCEL_PROJECT,
        teamId: process.env.WORKFLOW_VERCEL_TEAM,
      },
    };
  }

  if (backendId === '@workflow/world-postgres' || backendId === 'postgres') {
    // No safe postgres vars to expose.
    return {
      backendDisplayName,
      backendId,
      ...withDbUris,
      publicEnv: { kind: 'postgres' },
    };
  }

  if (backendId === 'local' || backendId === '@workflow/world-local') {
    const cwd = getObservabilityCwd();
    const dataDirInfo = await findWorkflowDataDir(cwd);
    return {
      backendDisplayName,
      backendId,
      ...withDbUris,
      publicEnv: {
        kind: 'local',
        port: process.env.PORT,
        dataDirPath: dataDirInfo.dataDir,
        projectDir: dataDirInfo.projectDir,
        shortName: dataDirInfo.shortName,
      },
    };
  }

  // Custom backend: expose no env-derived values.
  return {
    backendDisplayName,
    backendId,
    ...withDbUris,
    publicEnv: { kind: 'custom' },
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
 * Cache for World instances.
 *
 * IMPORTANT:
 * - We only cache non-vercel worlds.
 * - Cache keys are derived from **server-side** WORKFLOW_* env vars only.
 */
const worldCache = new Map<string, World>();

/**
 * Get or create a World instance based on configuration.
 *
 * The @workflow/web UI should always pass `{}` for envMap.
 * We intentionally do not trust or apply client-provided env.
 */
function getWorldFromEnv(_userEnvMap: EnvMap) {
  const backendId = getEffectiveBackendId();
  const isVercelWorld = ['vercel', '@workflow/world-vercel'].includes(
    backendId
  );

  // For the vercel world specifically, we do _not_ cache the world,
  // as it can be a multi-tenant environment.
  if (isVercelWorld) {
    return createVercelWorld({
      baseUrl: process.env.WORKFLOW_VERCEL_BACKEND_URL,
      skipProxy: process.env.WORKFLOW_VERCEL_SKIP_PROXY === 'true',
      token: process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
      projectConfig: {
        environment: process.env.WORKFLOW_VERCEL_ENV,
        projectId: process.env.WORKFLOW_VERCEL_PROJECT,
        teamId: process.env.WORKFLOW_VERCEL_TEAM,
      },
    });
  }

  // Cache key derived ONLY from WORKFLOW_* env vars.
  const workflowEnvEntries = Object.entries(process.env).filter(([key]) =>
    key.startsWith('WORKFLOW_')
  );
  workflowEnvEntries.sort(([a], [b]) => a.localeCompare(b));
  const cacheKey = JSON.stringify(Object.fromEntries(workflowEnvEntries));

  const cachedWorld = worldCache.get(cacheKey);
  if (cachedWorld) {
    return cachedWorld;
  }

  const world = createWorld();
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
  if (!status) {
    return `Error creating response: ${error.message}`;
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
  _worldEnv: EnvMap
): Promise<ServerActionResult<any>> {
  const cwd = getObservabilityCwd();

  // Helper to resolve path (absolute or relative to cwd)
  const resolvePath = (p: string) =>
    path.isAbsolute(p) ? p : path.join(cwd, p);

  // Build list of paths to try, in priority order
  const manifestPaths: string[] = [];

  // 1. Explicit manifest path configuration (highest priority)
  if (process.env.WORKFLOW_MANIFEST_PATH) {
    manifestPaths.push(resolvePath(process.env.WORKFLOW_MANIFEST_PATH));
  }

  // 2. Standard Next.js app router locations
  manifestPaths.push(
    path.join(cwd, 'app/.well-known/workflow/v1/manifest.json'),
    path.join(cwd, 'src/app/.well-known/workflow/v1/manifest.json')
  );

  // 3. Legacy data directory locations
  if (process.env.WORKFLOW_EMBEDDED_DATA_DIR) {
    manifestPaths.push(
      path.join(
        resolvePath(process.env.WORKFLOW_EMBEDDED_DATA_DIR),
        'manifest.json'
      )
    );
  }

  // Try each path until we find the manifest
  for (const manifestPath of manifestPaths) {
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      return createResponse(manifest);
    } catch (_err) {
      // Continue to next path
    }
  }

  // If no manifest found, return an empty manifest
  // This allows the UI to work without workflows graph data
  return createResponse({
    version: '1.0.0',
    steps: {},
    workflows: {},
  });
}
