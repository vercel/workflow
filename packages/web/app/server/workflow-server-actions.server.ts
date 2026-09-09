/**
 * Server-only module for workflow data access.
 *
 * The `.server.ts` suffix ensures Vite excludes this from client bundles.
 * These functions are called from React Router route loaders/actions.
 */

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as workflowRunHelpers from '@workflow/core/runtime';
import {
  type HealthCheckResult,
  healthCheck,
} from '@workflow/core/runtime/helpers';
import { resumeHook as resumeHookRuntime } from '@workflow/core/runtime/resume-hook';

import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { findWorkflowDataDir } from '@workflow/utils/check-data-dir';
import {
  discoverWorkflowSqliteDatabases,
  resolveWorkflowSqliteDatabaseDir,
} from '@workflow/utils/sqlite-database-dir';
import type {
  BulkCancelWorkflowRunsResult,
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
  World,
} from '@workflow/world';
import { createAggregatedObservabilityWorld } from '@workflow/world/observability';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { createWorld as createVercelBackendWorld } from '@workflow/world-vercel';
import type {
  HookListItem,
  HookTokenResult,
  ObservabilityWorkflowRun,
} from '~/lib/types';

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
   * Safe, whitelisted, env-derived values.
   *
   * Keys MUST match the canonical environment variable names (e.g. "WORKFLOW_VERCEL_PROJECT").
   * This keeps configuration naming consistent across CLI + web + docs.
   */
  publicEnv: Record<string, string>;
  /**
   * Keys for env vars that are allowed/known but considered sensitive.
   * The server will NOT return their values; UIs should display `*****`.
   */
  sensitiveEnvKeys: string[];
  /**
   * Additional safe, derived info for display (never contains secrets).
   * These keys are not env var names; they are UI-friendly derived fields.
   */
  displayInfo?: Record<string, string>;
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
    case 'sqlite':
    case '@workflow/world-sqlite':
      return 'SQLite';
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
 * Ensure local-world env is derived consistently when running `packages/web` directly.
 *
 * Without this, the UI may *display* a dataDir detected from WORKFLOW_OBSERVABILITY_CWD,
 * while the actual World reads from `WORKFLOW_LOCAL_DATA_DIR` (defaulting to `.workflow-data`
 * under the web package cwd), resulting in "no runs" even though data exists.
 */
async function ensureLocalWorldDataDirEnv(): Promise<void> {
  if (process.env.WORKFLOW_LOCAL_DATA_DIR) return;

  const cwd = getObservabilityCwd();
  const info = await findWorkflowDataDir(cwd);

  // Prefer a discovered workflow-data directory (e.g. `.next/workflow-data`).
  if (info.dataDir) {
    process.env.WORKFLOW_LOCAL_DATA_DIR = info.dataDir;
    return;
  }

  // Fall back to a canonical location under the target project directory.
  process.env.WORKFLOW_LOCAL_DATA_DIR = path.resolve(cwd, '.workflow-data');
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

// Keep this list in sync with `worlds-manifest.json` env + credentialsNote.
const WORLD_ENV_ALLOWLIST_BY_TARGET_WORLD: Record<string, string[]> = {
  // Official
  local: [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_LOCAL_DATA_DIR',
    'WORKFLOW_MANIFEST_PATH',
    'WORKFLOW_OBSERVABILITY_CWD',
    'PORT',
  ],
  '@workflow/world-local': [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_LOCAL_DATA_DIR',
    'WORKFLOW_MANIFEST_PATH',
    'WORKFLOW_OBSERVABILITY_CWD',
    'PORT',
  ],
  sqlite: [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_LOCAL_DATABASE_DIR',
    'WORKFLOW_MANIFEST_PATH',
    'WORKFLOW_OBSERVABILITY_CWD',
  ],
  '@workflow/world-sqlite': [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_LOCAL_DATABASE_DIR',
    'WORKFLOW_MANIFEST_PATH',
    'WORKFLOW_OBSERVABILITY_CWD',
  ],
  postgres: ['WORKFLOW_TARGET_WORLD', 'WORKFLOW_POSTGRES_URL'],
  '@workflow/world-postgres': [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_POSTGRES_URL',
  ],
  vercel: [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_VERCEL_ENV',
    'WORKFLOW_VERCEL_TEAM',
    'WORKFLOW_VERCEL_PROJECT',
    'WORKFLOW_VERCEL_PROJECT_NAME',
    'WORKFLOW_VERCEL_AUTH_TOKEN',
  ],
  '@workflow/world-vercel': [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_VERCEL_ENV',
    'WORKFLOW_VERCEL_TEAM',
    'WORKFLOW_VERCEL_PROJECT',
    'WORKFLOW_VERCEL_PROJECT_NAME',
    'WORKFLOW_VERCEL_AUTH_TOKEN',
  ],

  // Community (from worlds-manifest.json)
  '@workflow-worlds/starter': ['WORKFLOW_TARGET_WORLD'],
  '@workflow-worlds/turso': [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_TURSO_DATABASE_URL',
  ],
  '@workflow-worlds/mongodb': [
    'WORKFLOW_TARGET_WORLD',
    'WORKFLOW_MONGODB_URI',
    'WORKFLOW_MONGODB_DATABASE_NAME',
  ],
  '@workflow-worlds/redis': ['WORKFLOW_TARGET_WORLD', 'WORKFLOW_REDIS_URI'],
  'workflow-world-jazz': [
    'WORKFLOW_TARGET_WORLD',
    // credentialsNote:
    'JAZZ_API_KEY',
    'JAZZ_WORKER_ACCOUNT',
    'JAZZ_WORKER_SECRET',
  ],
};

function getAllowedEnvKeysForBackend(backendId: string): string[] {
  return (
    WORLD_ENV_ALLOWLIST_BY_TARGET_WORLD[backendId] ?? ['WORKFLOW_TARGET_WORLD']
  );
}

// Keep this list in sync with `worlds-manifest.json` env + credentialsNote.
//
// IMPORTANT: This is intentionally explicit (no heuristics). We only redact values for env
// vars that are known + whitelisted and that we *know* contain secrets/credentials.
const WORLD_SENSITIVE_ENV_KEYS = new Set<string>([
  // Official
  'WORKFLOW_POSTGRES_URL',
  'WORKFLOW_VERCEL_AUTH_TOKEN',

  // Community
  'WORKFLOW_TURSO_DATABASE_URL',
  'WORKFLOW_MONGODB_URI',
  'WORKFLOW_REDIS_URI',
  'JAZZ_API_KEY',
  'JAZZ_WORKER_SECRET',
]);

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}

function deriveDbInfoForKey(
  key: string,
  value: string
): Record<string, string> | null {
  // Only attempt for URL-like strings.
  if (!value.includes(':')) return null;
  try {
    const parsed = new URL(value);
    const protocol = (parsed.protocol || '').replace(':', '');
    // file: URIs are not useful for hostname/db display
    if (protocol === 'file') return null;
    const hostname = extractHostnameFromUrl(value);
    const database = extractDatabaseFromUrl(value);
    const out: Record<string, string> = {};
    if (hostname) out[`derived.${key}.hostname`] = hostname;
    if (database) out[`derived.${key}.database`] = database;
    if (protocol) out[`derived.${key}.protocol`] = protocol;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function getLocalDisplayInfo(): Promise<Record<string, string>> {
  const cwd = getObservabilityCwd();
  const dataDirInfo = await findWorkflowDataDir(cwd);
  const out: Record<string, string> = {
    'local.shortName': dataDirInfo.shortName,
    'local.projectDir': dataDirInfo.projectDir,
  };
  if (dataDirInfo.dataDir) {
    out['local.dataDirPath'] = dataDirInfo.dataDir;
  }
  return out;
}

async function getSqliteDisplayInfo(): Promise<Record<string, string>> {
  const databaseDir = resolveWorkflowSqliteDatabaseDir(getObservabilityCwd());
  const databases = await discoverWorkflowSqliteDatabases(databaseDir);
  return {
    'sqlite.databaseDirPath': databaseDir,
    'sqlite.databaseSources': databases.map(({ source }) => source).join(', '),
  };
}

function collectAllowedEnv(allowedKeys: string[]): {
  publicEnv: Record<string, string>;
  sensitiveEnvKeys: string[];
  derivedDisplayInfo: Record<string, string>;
} {
  const publicEnv: Record<string, string> = {};
  const sensitiveEnvKeys: string[] = [];
  const derivedDisplayInfo: Record<string, string> = {};

  for (const key of allowedKeys) {
    const value = process.env[key];
    if (!isSet(value)) continue;

    if (WORLD_SENSITIVE_ENV_KEYS.has(key)) {
      sensitiveEnvKeys.push(key);
      const derived = deriveDbInfoForKey(key, value);
      if (derived) Object.assign(derivedDisplayInfo, derived);
      continue;
    }

    publicEnv[key] = value;
  }

  return {
    publicEnv,
    sensitiveEnvKeys: Array.from(new Set(sensitiveEnvKeys)).sort(),
    derivedDisplayInfo,
  };
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
  const allowedKeys = getAllowedEnvKeysForBackend(backendId);

  const { publicEnv, sensitiveEnvKeys, derivedDisplayInfo } =
    collectAllowedEnv(allowedKeys);

  const displayInfo: Record<string, string> = { ...derivedDisplayInfo };
  if (backendId === 'local' || backendId === '@workflow/world-local') {
    Object.assign(displayInfo, await getLocalDisplayInfo());
  } else if (backendId === 'sqlite' || backendId === '@workflow/world-sqlite') {
    Object.assign(displayInfo, await getSqliteDisplayInfo());
  }

  const config: PublicServerConfig = {
    backendDisplayName,
    backendId,
    publicEnv,
    sensitiveEnvKeys,
    displayInfo: Object.keys(displayInfo).length ? displayInfo : undefined,
  };

  // Provide defaults for commonly expected keys without revealing extra secrets.
  if (
    (backendId === 'vercel' || backendId === '@workflow/world-vercel') &&
    !publicEnv.WORKFLOW_VERCEL_ENV
  ) {
    config.publicEnv.WORKFLOW_VERCEL_ENV = 'production';
  }

  return config;
}

export interface PaginatedResult<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
  pageInfo?: AnalyticsPageInfo;
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

interface AnalyticsPageInfo {
  currentLookbackDays: number;
  maxLookbackDays: number;
  currentWindowStart: Date;
  maxWindowStart: Date;
  upgradeAvailable: boolean;
}

const OBSERVABILITY_UPGRADE_REQUIRED_CODE = 'observability-upgrade-required';
const OBSERVABILITY_UPGRADE_REQUIRED_MESSAGE =
  'This workflow observability data is outside your current plan window. Upgrade Observability Plus to view up to 30 days of workflow data.';

function getPageInfo(result: unknown): AnalyticsPageInfo | undefined {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('pageInfo' in result)
  ) {
    return undefined;
  }
  return (result as { pageInfo?: AnalyticsPageInfo }).pageInfo;
}

/**
 * Cache for World instances.
 *
 * IMPORTANT:
 * - We do not cache Vercel worlds (multi-tenant configuration) or SQLite
 *   observability worlds (the discovered database set is dynamic).
 * - Cache keys are derived from **server-side** WORKFLOW_* env vars only.
 */
const worldCache = new Map<string, World>();

function isSqliteBackend(backendId: string): boolean {
  return backendId === 'sqlite' || backendId === '@workflow/world-sqlite';
}

/**
 * Get or create a World instance based on configuration.
 *
 * The @workflow/web UI should always pass `{}` for envMap.
 */
async function getWorldFromEnv(userEnvMap: EnvMap): Promise<World> {
  const backendId = getEffectiveBackendId();
  const isVercelWorld = ['vercel', '@workflow/world-vercel'].includes(
    backendId
  );

  // For the vercel world specifically, we do not cache the world,
  // and allow user-provided env, as it can be a multi-tenant environment,
  // and we instantiate the world per-user directly to avoid having to set
  // process.env.
  if (isVercelWorld) {
    return createVercelBackendWorld({
      token:
        userEnvMap.WORKFLOW_VERCEL_AUTH_TOKEN ||
        process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
      projectConfig: {
        environment:
          userEnvMap.WORKFLOW_VERCEL_ENV || process.env.WORKFLOW_VERCEL_ENV,
        projectId:
          userEnvMap.WORKFLOW_VERCEL_PROJECT ||
          process.env.WORKFLOW_VERCEL_PROJECT,
        projectName:
          userEnvMap.WORKFLOW_VERCEL_PROJECT_NAME ||
          process.env.WORKFLOW_VERCEL_PROJECT_NAME,
        teamId:
          userEnvMap.WORKFLOW_VERCEL_TEAM || process.env.WORKFLOW_VERCEL_TEAM,
      },
    });
  }

  // For other worlds, we intentionally do not trust or apply client-provided env,
  // to avoid potential security risks in self-hosted scenarios.

  // Ensure local-world reads from the same project directory the UI is inspecting.
  if (backendId === 'local' || backendId === '@workflow/world-local') {
    await ensureLocalWorldDataDirEnv();
  }

  // The directory is a live set: Vitest workers can add and remove databases
  // while the observability server remains running. A cached aggregate would
  // permanently retain the set found by its first request, so SQLite worlds
  // are request-scoped and disposed by `withWorldFromEnv` below.
  if (isSqliteBackend(backendId)) {
    return createWorldForBackend(backendId);
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

  const world = await createWorldForBackend(backendId);
  worldCache.set(cacheKey, world);
  return world;
}

/**
 * Run one server action against a World.
 *
 * Static backends retain their existing module cache. SQLite discovery is
 * intentionally request-scoped so every refresh sees the current application
 * and Vitest databases; all native read-only handles are closed afterwards.
 */
async function withWorldFromEnv<T>(
  userEnvMap: EnvMap,
  operation: (world: World) => Promise<T>
): Promise<T> {
  const sqlite = isSqliteBackend(getEffectiveBackendId());
  const world = await getWorldFromEnv(userEnvMap);
  let result: T;
  try {
    result = await operation(world);
  } catch (error) {
    if (sqlite) {
      try {
        await world.close?.();
      } catch (closeError) {
        console.warn(
          `[workflow] Failed to close SQLite observability world: ${closeError instanceof Error ? closeError.message : String(closeError)}`
        );
      }
    }
    throw error;
  }
  if (sqlite) await world.close?.();
  return result;
}

function closeWorldWithStream(
  stream: ReadableStream<Uint8Array>,
  world: World
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= Promise.resolve(world.close?.()).then(() => undefined);
    return closePromise;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await close();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        try {
          await close();
        } catch (closeError) {
          console.warn(
            `[workflow] Failed to close SQLite observability world: ${closeError instanceof Error ? closeError.message : String(closeError)}`
          );
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });
}

/**
 * Construct the world for the configured backend explicitly.
 *
 * `createWorld()` from `@workflow/core/runtime` is a static-injection stub:
 * framework build plugins alias it to the selected world package when the
 * user's app is built. The web UI selects its backend at runtime via env,
 * so it must construct worlds directly (mirroring the CLI's world setup).
 * The local world is a direct dependency; other world packages (e.g.
 * `@workflow/world-postgres` or community worlds) are resolved from the
 * inspected project's directory.
 */
async function createWorldForBackend(backendId: string): Promise<World> {
  if (backendId === 'local' || backendId === '@workflow/world-local') {
    return createLocalWorld();
  }

  if (backendId === 'sqlite' || backendId === '@workflow/world-sqlite') {
    return createSqliteObservabilityWorld(backendId);
  }

  const cwd = getObservabilityCwd();
  let worldPath: string;
  try {
    worldPath = createRequire(path.join(cwd, 'package.json')).resolve(
      backendId,
      { paths: [cwd] }
    );
  } catch {
    throw new Error(
      `Could not resolve workflow backend package "${backendId}" from "${cwd}". ` +
        'Make sure the package is installed in the inspected project.'
    );
  }
  const mod = (await import(pathToFileURL(worldPath).href)) as {
    createWorld?: () => World | Promise<World>;
    default?: { createWorld?: () => World | Promise<World> };
  };
  // Fall back to default.createWorld for CJS packages whose named exports
  // aren't statically detectable by cjs-module-lexer.
  const createWorldFn = mod.createWorld ?? mod.default?.createWorld;
  if (typeof createWorldFn !== 'function') {
    throw new Error(
      `Workflow backend package "${backendId}" does not export createWorld().`
    );
  }
  return createWorldFn();
}

async function createSqliteObservabilityWorld(
  backendId: string
): Promise<World> {
  const cwd = getObservabilityCwd();
  const packageId =
    backendId === 'sqlite' ? '@workflow/world-sqlite' : backendId;
  let worldPath: string;
  try {
    worldPath = createRequire(path.join(cwd, 'package.json')).resolve(
      packageId,
      { paths: [cwd] }
    );
  } catch {
    throw new Error(
      `Could not resolve workflow backend package "${packageId}" from "${cwd}". ` +
        'Make sure the package is installed in the inspected project.'
    );
  }
  const mod = (await import(pathToFileURL(worldPath).href)) as {
    createWorld?: (config?: Record<string, unknown>) => SqliteInspectionWorld;
    default?: {
      createWorld?: (config?: Record<string, unknown>) => SqliteInspectionWorld;
    };
  };
  const createWorld = mod.createWorld ?? mod.default?.createWorld;
  if (typeof createWorld !== 'function') {
    throw new Error(
      `Workflow backend package "${packageId}" does not expose the SQLite observability API.`
    );
  }

  const databaseDir = resolveWorkflowSqliteDatabaseDir(cwd);
  const candidates = await discoverWorkflowSqliteDatabases(databaseDir);
  const valid: { source: string; world: World }[] = [];
  try {
    for (const candidate of candidates) {
      const candidateWorld = createWorld({
        databaseFile: candidate.databasePath,
        readOnly: true,
        recoverActiveRuns: false,
      });
      try {
        await candidateWorld.validate();
        valid.push({ source: candidate.source, world: candidateWorld });
      } catch (error) {
        await candidateWorld.close?.();
        console.warn(
          `[workflow] Ignoring ${candidate.source}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (valid.length === 0) {
      throw new Error(
        `No schema-compatible Workflow SQLite databases found in "${databaseDir}".`
      );
    }

    return createAggregatedObservabilityWorld(valid);
  } catch (error) {
    await Promise.allSettled(valid.map(({ world }) => world.close?.()));
    throw error;
  }
}

type SqliteInspectionWorld = World & {
  validate(): Promise<void>;
};

/**
 * Creates a structured error object from a caught error
 */
function createServerActionError<T>(
  error: unknown,
  operation: string,
  requestParams?: Record<string, any>
): ServerActionResult<T> {
  const err = error instanceof Error ? error : new Error(String(error));
  let errorResponse: ServerActionError;

  if (WorkflowWorldError.is(error)) {
    // API-level errors (4xx/5xx from the world backend).
    // 4xx errors are client-recoverable and shouldn't spam logs.
    const status = error.status ?? 500;
    const isClientError = status >= 400 && status < 500;
    if (!isClientError) {
      console.error(`[web-api] ${operation} error:`, err);
    }
    errorResponse = {
      message: getUserFacingErrorMessage(err, error.status, error.code),
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
    // Run not found — expected during polling for recently created runs.
    errorResponse = {
      message: getUserFacingErrorMessage(error, 404),
      layer: 'API',
      cause: err.stack || err.message,
      request: { operation, status: 404, params: requestParams ?? {} },
    };
  } else {
    // Unrecognized errors (e.g., world backends throwing plain Error for 4xx).
    // The error is returned to the caller — no server-side logging needed.
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
function getUserFacingErrorMessage(
  error: Error,
  status?: number,
  code?: string
): string {
  if (!status) {
    return `Error creating response: ${error.message}`;
  }

  if (status === 402 && code === OBSERVABILITY_UPGRADE_REQUIRED_CODE) {
    return OBSERVABILITY_UPGRADE_REQUIRED_MESSAGE;
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

/**
 * Helper to create successful responses.
 * Data is passed through as-is — CBOR transport preserves Uint8Array
 * and other types. Hydration happens client-side.
 */
function createResponse<T>(data: T): ServerActionResult<T> {
  return {
    success: true,
    data,
  };
}

export async function withObservabilitySource(
  world: World,
  resource: WorkflowRun
): Promise<ObservabilityWorkflowRun> {
  try {
    const fields = await world.describeRun?.(resource);
    const source = fields?.observabilitySource;
    return typeof source === 'string'
      ? { ...resource, observabilitySource: source }
      : resource;
  } catch {
    return resource;
  }
}

interface FetchRunsParams {
  cursor?: string;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  workflowName?: string;
  status?: WorkflowRunStatus;
  /**
   * Optional listing window (ISO timestamps, both required together).
   * Honored by the analytics read path, where it bounds the backend scan;
   * the runtime storage APIs have no time filter, so the fallback path ignores
   * it. Windows outside the plan's observability lookback surface as a 402
   * `observability-upgrade-required` error.
   */
  startTime?: string;
  endTime?: string;
}

async function listRunsFromWorld(
  world: World,
  params: Required<Pick<FetchRunsParams, 'sortOrder' | 'limit'>> &
    Omit<FetchRunsParams, 'sortOrder' | 'limit'>
) {
  const { cursor, sortOrder, limit, workflowName, status, startTime, endTime } =
    params;
  const filters = {
    ...(workflowName ? { workflowName } : {}),
    ...(status ? { status } : {}),
    pagination: { cursor, limit, sortOrder },
  };
  if (world.analytics) {
    return world.analytics.runs.list({
      ...filters,
      ...(startTime && endTime ? { startTime, endTime } : {}),
    });
  }
  return world.runs.list({ ...filters, resolveData: 'none' });
}

/**
 * Fetch paginated list of workflow runs
 */
export async function fetchRuns(
  worldEnv: EnvMap,
  params: FetchRunsParams
): Promise<ServerActionResult<PaginatedResult<ObservabilityWorkflowRun>>> {
  const {
    cursor,
    sortOrder = 'desc',
    limit = 10,
    workflowName,
    status,
    startTime,
    endTime,
  } = params;
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      // Prefer the metadata-only analytics read path when the backend provides
      // one; fall back to the runtime storage API otherwise.
      const result = await listRunsFromWorld(world, {
        cursor,
        sortOrder,
        limit,
        workflowName,
        status,
        startTime,
        endTime,
      });
      const runs = await Promise.all(
        (result.data as unknown as WorkflowRun[]).map((run) =>
          withObservabilitySource(world, run)
        )
      );
      return createResponse({
        data: runs,
        cursor: result.cursor ?? undefined,
        hasMore: result.hasMore,
        pageInfo: getPageInfo(result),
      });
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<ObservabilityWorkflowRun>>(
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
): Promise<ServerActionResult<ObservabilityWorkflowRun>> {
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      const run = await world.runs.get(runId, { resolveData });
      return createResponse(
        await withObservabilitySource(world, run as WorkflowRun)
      );
    });
  } catch (error) {
    return createServerActionError<ObservabilityWorkflowRun>(
      error,
      'world.runs.get',
      { runId, resolveData }
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
    return await withWorldFromEnv(worldEnv, async (world) => {
      const step = await world.steps.get(runId, stepId, { resolveData });
      return createResponse(step as Step);
    });
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
    withData?: boolean;
  }
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  const { cursor, sortOrder = 'asc', limit = 1000, withData = false } = params;
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      // Run-scoped, so it reads storage rather than analytics. The analytics
      // namespace is a metadata mirror with a shorter retention window and
      // asynchronous ingestion, so it returned an empty list for a run older
      // than that window and could trail a run still executing. This listing
      // backs both the trace viewer and the events tab.
      const result = await world.events.list({
        runId,
        pagination: { cursor, limit, sortOrder },
        resolveData: withData ? 'all' : 'none',
      });
      return createResponse({
        data: result.data as unknown as Event[],
        cursor: result.cursor ?? undefined,
        hasMore: result.hasMore,
        pageInfo: getPageInfo(result),
      });
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
 * Fetch a single event by run ID and event ID
 */
export async function fetchEvent(
  worldEnv: EnvMap,
  runId: string,
  eventId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<Event>> {
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      const event = await world.events.get(runId, eventId, { resolveData });
      return createResponse(event as Event);
    });
  } catch (error) {
    return createServerActionError<Event>(error, 'world.events.get', {
      runId,
      eventId,
      resolveData,
    });
  }
}

/**
 * Fetch paginated events for a step correlation ID.
 */
export async function fetchEventsByCorrelationId(
  worldEnv: EnvMap,
  correlationId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    withData?: boolean;
    /**
     * The run the correlation id belongs to. A correlation id is unique per
     * run, not globally — a slot-numbered run numbers its own steps — so the
     * search is always made from a run's page and names it.
     */
    runId: string;
  }
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  const {
    cursor,
    sortOrder = 'asc',
    limit = 100,
    withData = false,
    runId,
  } = params;
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      // Run-scoped, so it reads storage — see `fetchEvents` for why the
      // analytics path was withdrawn. `runId` is required, which keeps the
      // answer scoped to one run: a correlation id is unique within its run,
      // not across runs.
      const result = await world.events.listByCorrelationId({
        correlationId,
        runId,
        pagination: { cursor, limit, sortOrder },
        resolveData: withData ? 'all' : 'none',
      });
      return createResponse({
        data: result.data as unknown as Event[],
        cursor: result.cursor ?? undefined,
        hasMore: result.hasMore,
        pageInfo: getPageInfo(result),
      });
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
export function hookToListItem(hook: Hook): HookListItem {
  const { token: _token, ...hookListItem } = hook;
  return hookListItem;
}

export async function fetchHooks(
  worldEnv: EnvMap,
  params: {
    runId?: string;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<ServerActionResult<PaginatedResult<HookListItem>>> {
  const { runId, cursor, sortOrder = 'desc', limit = 10 } = params;
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      // Prefer the metadata-only analytics read path when the backend provides
      // one and the run scope required by analytics is present. The hook list is
      // metadata only — the secret `token` is fetched on demand per hook via
      // `fetchHookToken` for the copy-token and resume affordances — so the list
      // never carries it.
      if (world.analytics && runId) {
        const result = await world.analytics.hooks.list({
          runId,
          pagination: { cursor, limit, sortOrder },
        });
        return createResponse({
          data: result.data as unknown as HookListItem[],
          cursor: result.cursor ?? undefined,
          hasMore: result.hasMore,
          pageInfo: getPageInfo(result),
        });
      }
      const result = await world.hooks.list({
        ...(runId ? { runId } : {}),
        pagination: { cursor, limit, sortOrder },
        resolveData: 'none',
      });
      return createResponse({
        data: result.data.map(hookToListItem),
        cursor: result.cursor ?? undefined,
        hasMore: result.hasMore,
        pageInfo: getPageInfo(result),
      });
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<HookListItem>>(
      error,
      'world.hooks.list',
      params
    );
  }
}

/**
 * Fetch a single hook's secret token on demand.
 *
 * Hook list rows are metadata-only; the token is read from the runtime storage
 * API one hook at a time, only when the user reveals/copies it or resumes the
 * hook. This keeps the secret out of bulk list responses.
 */
export async function fetchHookToken(
  worldEnv: EnvMap,
  runId: string,
  hookId: string
): Promise<ServerActionResult<HookTokenResult>> {
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      const hook = await world.hooks.get(hookId, { resolveData: 'none' });
      return createResponse({ token: hook.token });
    });
  } catch (error) {
    return createServerActionError<HookTokenResult>(error, 'world.hooks.get', {
      runId,
      hookId,
    });
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
    return await withWorldFromEnv(worldEnv, async (world) => {
      const hook = await world.hooks.get(hookId, { resolveData });
      return createResponse(hook as Hook);
    });
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
    return await withWorldFromEnv(worldEnv, async (world) => {
      await workflowRunHelpers.cancelRun(world, runId);
      return createResponse(undefined);
    });
  } catch (error) {
    return createServerActionError<void>(error, 'world.events.create', {
      runId,
    });
  }
}

/**
 * Bulk-cancel workflow runs in a single operation.
 *
 * Delegates to `cancelRuns`, which uses the world's native batch endpoint when
 * available and otherwise falls back to bounded-concurrency single-run
 * cancellation. Per-run outcomes are reported in the returned summary rather
 * than thrown, so a partial failure still resolves.
 */
export async function bulkCancelRuns(
  worldEnv: EnvMap,
  runIds: string[]
): Promise<ServerActionResult<BulkCancelWorkflowRunsResult>> {
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      const result = await workflowRunHelpers.cancelRuns(world, runIds);
      return createResponse(result);
    });
  } catch (error) {
    return createServerActionError<BulkCancelWorkflowRunsResult>(
      error,
      'world.runs.cancelMany',
      { runIdCount: runIds.length }
    );
  }
}

/**
 * Start a new workflow run.
 *
 * This requires the ID of an existing run of which to re-use the deployment ID of.
 */
export async function recreateRun(
  worldEnv: EnvMap,
  runId: string,
  deploymentId?: string
): Promise<ServerActionResult<string>> {
  try {
    return await withWorldFromEnv({ ...worldEnv }, async (world) => {
      const newRunId = await workflowRunHelpers.recreateRunFromExisting(
        world,
        runId,
        {
          deploymentId,
        }
      );
      return createResponse(newRunId);
    });
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
    return await withWorldFromEnv({ ...worldEnv }, async (world) => {
      await workflowRunHelpers.reenqueueRun(world, runId);
      return createResponse(undefined);
    });
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
    return await withWorldFromEnv({ ...worldEnv }, async (world) => {
      const result = await workflowRunHelpers.wakeUpRun(world, runId, options);
      return createResponse(result);
    });
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
    return await withWorldFromEnv({ ...worldEnv }, async () => {
      const hook = await resumeHookRuntime(token, payload);

      return createResponse({
        hookId: hook.hookId,
        runId: hook.runId,
      });
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
  startIndex: number | undefined,
  runId: string
): Promise<ReadableStream<Uint8Array> | ServerActionError> {
  const sqlite = isSqliteBackend(getEffectiveBackendId());
  let world: World | undefined;
  try {
    world = await getWorldFromEnv(env);
    // Return the raw binary stream — deserialization and decryption
    // happen entirely client-side.
    const stream = await world.streams.get(runId, streamId, startIndex);
    return sqlite ? closeWorldWithStream(stream, world) : stream;
  } catch (error) {
    if (sqlite && world) {
      try {
        await world.close?.();
      } catch (closeError) {
        console.warn(
          `[workflow] Failed to close SQLite observability world: ${closeError instanceof Error ? closeError.message : String(closeError)}`
        );
      }
    }
    const actionError = createServerActionError(error, 'world.streams.get', {
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

const CHUNKS_PAGE_SIZE = 500;

export interface StreamChunksResult {
  buffer: Uint8Array;
  /** Cursor the client should send back on the next poll to resume, or null */
  cursor: string | null;
  /** Whether the stream is fully closed (no more chunks will ever be written) */
  done: boolean;
}

/**
 * Fetch stream chunks using paginated batch API.
 *
 * When `startCursor` is provided, only chunks after that position are
 * returned — used for incremental polling so previously-seen data is
 * never re-transferred. Returns a `cursor` the client passes back on
 * the next request.
 */
export async function readStreamChunksServerAction(
  env: EnvMap,
  streamId: string,
  runId: string,
  startCursor?: string
): Promise<StreamChunksResult | ServerActionError> {
  try {
    return await withWorldFromEnv(env, async (world) => {
      const allChunks: Uint8Array[] = [];
      let pageCursor: string | undefined = startCursor;
      let streamDone = false;
      // Track the last non-null cursor so we can resume from the start of
      // the final page on the next poll. When getChunks returns
      // cursor=null we've exhausted all pages, but this saved cursor lets
      // the client re-fetch only the last page + any new chunks.
      let resumeCursor: string | null = startCursor ?? null;

      do {
        const result = await world.streams.getChunks(runId, streamId, {
          limit: CHUNKS_PAGE_SIZE,
          cursor: pageCursor,
        });

        for (const chunk of result.data) {
          allChunks.push(chunk.data);
        }

        streamDone = result.done;
        if (result.cursor) {
          resumeCursor = result.cursor;
        }
        pageCursor = result.cursor ?? undefined;
      } while (pageCursor);

      let totalSize = 0;
      for (const chunk of allChunks) {
        totalSize += chunk.length;
      }

      const body = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of allChunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }

      return { buffer: body, cursor: resumeCursor, done: streamDone };
    });
  } catch (error) {
    const actionError = createServerActionError(
      error,
      'world.streams.getChunks',
      { streamId, runId }
    );
    if (!actionError.success) {
      return actionError.error;
    }
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
    return await withWorldFromEnv(env, async (world) => {
      const streams = await world.streams.list(runId);
      return createResponse(streams);
    });
  } catch (error) {
    return createServerActionError<string[]>(error, 'world.streams.list', {
      runId,
    });
  }
}

/**
 * Fetch the workflows manifest from the workflow route directory
 * The manifest is generated at build time and contains static structure info about workflows
 *
 * Configuration priority:
 * 1. WORKFLOW_MANIFEST_PATH - explicit path to the manifest file
 * 2. WORKFLOW_LOCAL_DATA_DIR - local world data directory (manifest.json)
 * 3. Standard Next.js app router locations (app/.well-known/workflow/v1/manifest.json)
 * 4. WORKFLOW_EMBEDDED_DATA_DIR - legacy data directory
 */
export async function fetchWorkflowsManifest(
  _worldEnv: EnvMap
): Promise<ServerActionResult<any>> {
  // Ensure local-world data dir is derived when running packages/web directly.
  await ensureLocalWorldDataDirEnv();

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

  // 2. Local world data directory manifest
  if (process.env.WORKFLOW_LOCAL_DATA_DIR) {
    const localDataDir = resolvePath(process.env.WORKFLOW_LOCAL_DATA_DIR);
    manifestPaths.push(path.join(localDataDir, 'manifest.json'));

    // When local data lives in `.next/workflow-data`, the manifest is typically
    // generated under the project app router path, not inside the data dir.
    const localInfo = await findWorkflowDataDir(localDataDir);
    manifestPaths.push(
      path.join(
        localInfo.projectDir,
        'app/.well-known/workflow/v1/manifest.json'
      ),
      path.join(
        localInfo.projectDir,
        'src/app/.well-known/workflow/v1/manifest.json'
      )
    );
  }

  // 3. Standard Next.js app router locations
  manifestPaths.push(
    path.join(cwd, 'app/.well-known/workflow/v1/manifest.json'),
    path.join(cwd, 'src/app/.well-known/workflow/v1/manifest.json')
  );

  // 4. Legacy data directory locations
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

/**
 * Run a queue-based health check on a workflow endpoint.
 *
 * This sends a health check message through the Queue infrastructure,
 * bypassing Vercel Deployment Protection. The endpoint processes the
 * message and writes a response to a stream, which we then read to
 * verify the endpoint is healthy.
 *
 * @param worldEnv - Environment configuration for the World
 * @param options - Optional configuration (timeout in ms)
 */
export async function runHealthCheck(
  worldEnv: EnvMap,
  options?: { timeout?: number }
): Promise<ServerActionResult<HealthCheckResult>> {
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      const result = await healthCheck(world, options);
      return createResponse({
        ...result,
      });
    });
  } catch (error) {
    // For health check failures, we want to return success=true with healthy=false
    // so the UI can display the error properly, rather than propagating the server
    // action error. This allows the health check result to be parsed by the UI
    // even when the endpoint is down or unreachable.
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createResponse({
      healthy: false,
      error: errorMessage,
      latencyMs: undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Encryption key retrieval for client-side decryption
// ---------------------------------------------------------------------------

/**
 * Retrieve the encryption key for a specific run.
 *
 * The World resolves the per-run AES-256 key (including HKDF derivation
 * and cross-deployment key retrieval). The raw key bytes are returned
 * to the browser for client-side decryption via core's AES-GCM.
 */
export async function getEncryptionKeyForRun(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<Uint8Array | null>> {
  try {
    return await withWorldFromEnv(worldEnv, async (world) => {
      if (!world.getEncryptionKeyForRun) {
        return createResponse(null);
      }
      // Fetch the full run so the World can inspect deploymentId etc.
      const run = await world.runs.get(runId);
      const key = await world.getEncryptionKeyForRun(run);
      return createResponse(key ?? null);
    });
  } catch (error) {
    return createServerActionError<Uint8Array | null>(
      error,
      'getEncryptionKeyForRun',
      { runId }
    );
  }
}
