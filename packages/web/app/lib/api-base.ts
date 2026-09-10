/**
 * Base path the observability UI is mounted under.
 *
 * The standalone server mounts at the root (`""`), but when embedded in another
 * server (e.g. `@workflow/nitro` at `/_workflow`) the API resource routes live
 * under that prefix. The server threads the mount path through the React Router
 * load context; `app/root.tsx` surfaces it to the browser via a global so that
 * client-only `fetch` calls (RPC + stream reads) can target the right path
 * regardless of the current route.
 */

declare global {
  interface Window {
    __WORKFLOW_BASENAME__?: string;
  }
}

/**
 * Returns the mount-path prefix for client-side API fetches (e.g. `""` at the
 * root, or `"/_workflow"` when embedded). Always client-only — server code
 * reaches the world directly rather than via these HTTP routes.
 */
export function apiBase(): string {
  if (typeof window === 'undefined') return '';
  return window.__WORKFLOW_BASENAME__ ?? '';
}
