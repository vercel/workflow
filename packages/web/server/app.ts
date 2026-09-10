import 'react-router';
// The React Router server build (virtual module). Imported as a namespace so we
// can both hand it to the Express handler (standalone server.js) and reprefix a
// copy of it for the framework-agnostic embedded handler below.
import * as serverBuild from 'virtual:react-router/server-build';
import { createRequestHandler as createExpressRequestHandler } from '@react-router/express';
import express from 'express';
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

export const app = express();

// Handle all requests with React Router.
// Static file serving is handled by:
// - Vite's dev server in development
// - server.js in production (before mounting this app)
app.all(
  '/{*splat}',
  createExpressRequestHandler({
    build: () => import('virtual:react-router/server-build'),
  })
);

// Safety-net error handler — prevents unhandled errors from crashing the
// server when the React Router error boundary cannot render (e.g. during SSR).
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
);

// --- Framework-agnostic fetch handler (for embedding under a base path) -------
//
// `@workflow/web/handler` (a thin sibling file that ships as-is) imports this to
// mount the dashboard in-process inside another server — e.g. `@workflow/nitro`
// at `/_workflow` — without spawning a second HTTP server. React Router itself
// is bundled into this build, so the `createRequestHandler` wiring must live
// here rather than in the un-bundled `handler.js`.

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
