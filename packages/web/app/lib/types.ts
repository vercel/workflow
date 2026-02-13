/**
 * Shared types that are used by both server and client code.
 * This file should NOT import any server-only modules.
 */

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
 * Environment variable map for world configuration.
 */
export type EnvMap = Record<string, string | undefined>;

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

export interface PaginatedResult<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

export interface StopSleepResult {
  /** Number of pending sleeps that were stopped */
  stoppedCount: number;
}

export interface StopSleepOptions {
  correlationIds?: string[];
}

export interface ResumeHookResult {
  hookId: string;
  runId: string;
}

export type {
  HealthCheckEndpoint,
  HealthCheckResult,
} from '@workflow/core/runtime/helpers';
