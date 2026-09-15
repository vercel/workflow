/**
 * Best-effort registry of live, embedded observability dashboards.
 *
 * When the dashboard is embedded in another server (e.g. `@workflow/nitro` at
 * `/_workflow`), the running process records its public URL here. The CLI
 * (`workflow web` / `inspect … --web`) reads this so it can point the user at
 * an already-running dashboard instead of spawning a redundant standalone
 * server on a fixed port.
 *
 * This is a coordination hint, never a source of truth: entries may be stale
 * (a SIGKILL'd dev server can't clean up), so consumers MUST health-check a URL
 * before trusting it. A missing or corrupt registry is treated as "none".
 *
 * The file is keyed by the current working directory so multiple projects don't
 * collide, while multiple dev servers for the same project share one file
 * (keyed by pid within it).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Absolute path of the registry file for the current working directory. */
export function dashboardRegistryPath() {
  const key = createHash('sha256')
    .update(process.cwd())
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), 'workflow-observability', `${key}.json`);
}

/** Read the registry entries (always returns an array; never throws). */
export function readDashboardRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(dashboardRegistryPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  const file = dashboardRegistryPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entries));
}

let recorded = false;

/**
 * Record this process's embedded dashboard in the registry (idempotent per
 * process). Call once the public origin is known (e.g. from the first request).
 * Entirely best-effort — never throws.
 *
 * @param {{ url: string, basename?: string, world?: string }} entry
 */
export function recordDashboard(entry) {
  if (recorded) return;
  recorded = true;
  try {
    const others = readDashboardRegistry().filter(
      (e) => e && e.pid !== process.pid
    );
    others.push({
      url: entry.url,
      basename: entry.basename ?? '',
      world: entry.world ?? '',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    writeEntries(others);
    // Best-effort cleanup on normal exit. Signal-terminated processes (Ctrl+C,
    // SIGKILL) won't run this — consumers prune via health checks instead. We
    // intentionally don't hook SIGINT/SIGTERM so we don't interfere with the
    // host framework's own shutdown handling.
    process.once('exit', () => {
      try {
        writeEntries(
          readDashboardRegistry().filter((e) => e && e.pid !== process.pid)
        );
      } catch {
        // ignore
      }
    });
  } catch {
    // best-effort: a failed write must never break request handling
  }
}
