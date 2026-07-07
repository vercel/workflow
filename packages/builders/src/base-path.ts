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

/**
 * Statement that sets the runtime base path global — injected into server
 * bundles so runtime URL generation includes the base path. The symbol
 * string must stay in sync with the canonical definition in
 * `@workflow/utils/src/workflow-routes.ts` (which reads it) and the CJS
 * copy in `@workflow/next`; it is inlined here because this is generated
 * code, evaluated in bundles where no `@workflow/utils` import exists.
 */
export function createWorkflowBasePathRuntimeCode(basePath: string): string {
  return `globalThis[Symbol.for('@workflow/core/basePath')] = ${JSON.stringify(basePath)};`;
}
