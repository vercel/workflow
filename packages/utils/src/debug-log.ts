/**
 * The `DEBUG` gate for diagnostic log lines emitted by the layers below
 * `@workflow/core`.
 *
 * `@workflow/core` has a real logger (`packages/core/src/logger.ts`) whose
 * `debug`/`info` levels are already gated this way. The packages under it —
 * `@workflow/utils`, `@workflow/world`, `@workflow/world-local`,
 * `@workflow/world-vercel` — carry no logger dependency, so a breadcrumb there
 * is a bare `console.*` call: unconditional, and therefore in every user's
 * function logs on a normal run. This is the gate those call sites use instead.
 *
 * Accepts the same selectors a namespaced logger would match for a line that
 * has no namespace of its own: any `workflow:`-prefixed pattern, or `*`.
 */
export function isWorkflowDebugEnabled(): boolean {
  // Read per call rather than captured at module load. A World is often
  // constructed long after import (and a test sets `DEBUG` in `beforeEach`),
  // so a module-scope constant answers for the wrong moment.
  const debug = typeof process !== 'undefined' ? process.env.DEBUG : undefined;
  if (typeof debug !== 'string') return false;
  return debug.includes('workflow:') || debug === '*';
}

/**
 * Emit a diagnostic line only under `DEBUG`.
 *
 * `console.debug` to match the rest of the SDK's debug output — core's logger,
 * world-vercel's `httpLog` and `logRetry` — so one `DEBUG=workflow:*` collects
 * all of it. Use this for anything a *successful* run would print; a genuine
 * anomaly still belongs on `console.warn`/`console.error`, which stay
 * unconditional so a broken run is never silent.
 */
export function debugLog(...args: unknown[]): void {
  if (!isWorkflowDebugEnabled()) return;
  console.debug(...args);
}
