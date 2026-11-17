/**
 * Bundling probe (see `app/api/bp/*`): the first module a probe route
 * imports, so its timestamps mark the start of the route module's evaluation.
 */
export const moduleStartedAt = Date.now();
export const uptimeAtModuleStartMs = Math.round(process.uptime() * 1000);

const BOOT = Symbol.for('workbench/bundling-probe/boot');

/** A random ID for this process, shared by the routes and the steps it runs. */
export function bootId(): string {
  const g = globalThis as typeof globalThis & { [BOOT]?: string };
  g[BOOT] ??= crypto.randomUUID();
  return g[BOOT];
}
