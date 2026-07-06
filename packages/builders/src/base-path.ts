/**
 * Shared base path helpers for the non-Next.js integrations.
 *
 * Next.js needs none of this: it owns its entire routing surface, so
 * `@workflow/next` only forwards `nextConfig.basePath` into the builder
 * config. For the other frameworks the Workflow SDK generates the routing
 * artifacts itself (Build Output API functions and routes, generated route
 * files, runtime globals), and Astro, Nitro, and SvelteKit all need the
 * same normalization and code generation.
 */

/**
 * Normalizes a framework base path config value (`/app`, `/app/`, `app/`,
 * `/`, undefined, ...) to either '' (no base path) or `/base` with a
 * leading and no trailing slash.
 */
export function normalizeWorkflowBasePath(
  basePath: string | undefined
): string {
  if (!basePath || basePath === '/') {
    return '';
  }

  const withoutTrailingSlash = basePath.replace(/\/+$/, '');

  if (!withoutTrailingSlash) {
    return '';
  }

  return withoutTrailingSlash.startsWith('/')
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
}

export function joinWorkflowBasePath(
  basePath: string | undefined,
  path: string
): string {
  return `${normalizeWorkflowBasePath(basePath)}${path}`;
}

/**
 * Statement that sets the runtime base path global (read by
 * `@workflow/utils` workflow-routes helpers) — injected into server
 * bundles so runtime URL generation includes the base path.
 */
export function createWorkflowBasePathRuntimeCode(basePath: string): string {
  return `globalThis[Symbol.for('@workflow/core/basePath')] = ${JSON.stringify(basePath)};`;
}

/**
 * Function expression that detects Vercel queue trigger deliveries from a
 * `Headers` object. Queue deliveries invoke the flow function with the
 * root-relative route path, so servers mounted below a base path must
 * rewrite exactly these requests (and no plain HTTP requests) onto the
 * base-prefixed route. Deliveries always carry the CloudEvents type header;
 * `vqs-message-id` is kept as a fallback since some launchers surface only
 * that one.
 */
export const QUEUE_DELIVERY_HEADERS_GUARD_CODE = `(headers) =>
  Boolean(
    headers?.get?.('ce-type')?.startsWith('com.vercel.queue.') ||
      headers?.get?.('vqs-message-id')
  )`;
