/** A recorded embedded-dashboard instance. */
export interface DashboardRegistryEntry {
  /** Public base URL the dashboard is reachable at (e.g. `http://localhost:3000/_workflow`). */
  url: string;
  /** Mount path the dashboard is served under (e.g. `/_workflow`; `""` at root). */
  basename: string;
  /** World backend identifier, for display (e.g. `local`, `@workflow/world-postgres`). */
  world: string;
  /** PID of the process hosting the dashboard. */
  pid: number;
  /** ISO timestamp the entry was recorded. */
  startedAt: string;
}

/** Absolute path of the registry file for the current working directory. */
export function dashboardRegistryPath(): string;

/** Read the registry entries (always returns an array; never throws). */
export function readDashboardRegistry(): DashboardRegistryEntry[];

/**
 * Record this process's embedded dashboard (idempotent per process). Entirely
 * best-effort — never throws.
 */
export function recordDashboard(entry: {
  url: string;
  basename?: string;
  world?: string;
}): void;
