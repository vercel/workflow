import 'react-router';
// The React Router server build (virtual module). Imported as a namespace so we
// can reprefix a copy of it for a mounted base path (see `reprefixBuild`).
import * as serverBuild from 'virtual:react-router/server-build';
import {
  type AppLoadContext,
  createRequestHandler as createReactRouterRequestHandler,
  type ServerBuild,
} from 'react-router';

// Expose `basename` on the React Router load context so the root route can
// surface the embed mount path to the client (see app/root.tsx + lib/api-base).
declare module 'react-router' {
  interface AppLoadContext {
    basename?: string;
  }
}

// --- Framework-agnostic fetch handler ----------------------------------------
//
// This module is the SSR build's only entry point, and `createFetchHandler` its
// only export. Both consumers go through it:
//
// - `server.js` — the standalone server, which mounts it at `/` behind srvx's
//   static middleware.
// - `@workflow/web/handler` — a thin sibling file that ships as-is, used to
//   mount the dashboard in-process inside another server (e.g. `@workflow/nitro`
//   at `/_workflow`) without spawning a second HTTP server.
//
// React Router itself is bundled into this build, so the `createRequestHandler`
// wiring must live here rather than in the un-bundled `handler.js`. Static file
// serving is *not* handled here — Vite's dev server covers it in development,
// and each consumer layers its own in front for production.

/** Normalize a mount path: `/` or empty -> "" (root); otherwise strip trailing slash. */
function normalizeBasename(basename: string): string {
  if (!basename || basename === '/') return '';
  return basename.endsWith('/') ? basename.slice(0, -1) : basename;
}

/**
 * Return a copy of the server build with every root-absolute asset URL (and
 * `publicPath`) reprefixed by `basename`. The build is produced with Vite base
 * "/", so assets are emitted at `/assets/...`; under a mount prefix both the SSR
 * document and the client-serialized manifest must resolve them at
 * `<basename>/assets/...`. Routing is handled separately via `basename`.
 */
function reprefixBuild(build: ServerBuild, basename: string): ServerBuild {
  const pre = <T extends string | undefined>(url: T): T =>
    typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
      ? ((basename + url) as T)
      : url;
  const preArr = (arr: string[] | undefined) =>
    Array.isArray(arr) ? arr.map((u) => pre(u)) : arr;

  const { assets } = build;
  const routes: typeof assets.routes = {};
  for (const [id, route] of Object.entries(assets.routes)) {
    routes[id] = {
      ...route,
      module: pre(route.module),
      imports: preArr(route.imports),
      css: preArr(route.css),
      clientActionModule: pre(route.clientActionModule),
      clientLoaderModule: pre(route.clientLoaderModule),
      clientMiddlewareModule: pre(route.clientMiddlewareModule),
      hydrateFallbackModule: pre(route.hydrateFallbackModule),
    };
  }

  return {
    ...build,
    basename,
    publicPath: pre(build.publicPath) || build.publicPath,
    assets: {
      ...assets,
      url: pre(assets.url),
      entry: {
        ...assets.entry,
        module: pre(assets.entry.module),
        imports: preArr(assets.entry.imports) ?? assets.entry.imports,
      },
      routes,
    },
  };
}

/**
 * Build a framework-agnostic Web `Request` -> `Response` handler for the
 * observability UI, suitable for mounting inside another server under an
 * arbitrary base path. Pass `basename` as the mount prefix (e.g. `/_workflow`);
 * `/` (the default) mounts at the root.
 *
 * The mount prefix is threaded into the React Router load context so the root
 * route can expose it to the client (RPC/stream fetches need the prefix).
 */
export function createFetchHandler(
  basename = '/'
): (request: Request) => Promise<Response> {
  const normalized = normalizeBasename(basename);
  const build = normalized
    ? reprefixBuild(serverBuild as unknown as ServerBuild, normalized)
    : (serverBuild as unknown as ServerBuild);
  const handler = createReactRouterRequestHandler(build, 'production');
  const loadContext: AppLoadContext = { basename: normalized };
  return (request: Request) => handler(request, loadContext);
}
