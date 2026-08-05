/**
 * Framework-agnostic, in-process entry point for @workflow/web.
 *
 * Unlike `server.js` (which starts a standalone HTTP server of its own), this
 * exports a single Web-standard fetch handler that another server can mount
 * under an arbitrary base path — e.g. `@workflow/nitro` mounting the dashboard
 * at `/_workflow` without spawning a second server/port.
 *
 *   import { createWorkflowWebHandler } from "@workflow/web/handler";
 *   const handler = await createWorkflowWebHandler({ basename: "/_workflow" });
 *   const response = await handler(request); // (request: Request) => Response
 *
 * The handler serves both the prebuilt static client assets (from `build/client`)
 * and the React Router SSR app. It reads the prebuilt `build/` as-is in every
 * mode (it never runs Vite), so consumers must have built @workflow/web first
 * (the published package ships `build/`).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordDashboard } from './registry.js';
import { createStaticHandler } from './static.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, 'build');
const clientDir = path.join(buildDir, 'client');
const serverEntry = path.join(buildDir, 'server', 'index.js');

/** Normalize a mount path: `/` or empty -> "" (root); otherwise strip trailing slash. */
function normalizeBasename(basename) {
  if (!basename || basename === '/') return '';
  return basename.endsWith('/') ? basename.slice(0, -1) : basename;
}

// One handler per basename, lazily constructed and memoized so repeated
// requests reuse the same React Router handler and module import.
const handlerCache = new Map();

/**
 * @param {{ basename?: string }} [options]
 * @returns {Promise<(request: Request) => Promise<Response>>}
 */
export async function createWorkflowWebHandler(options = {}) {
  const basename = normalizeBasename(options.basename ?? '/');
  let promise = handlerCache.get(basename);
  if (!promise) {
    promise = buildHandler(basename).catch((err) => {
      handlerCache.delete(basename);
      throw err;
    });
    handlerCache.set(basename, promise);
  }
  return promise;
}

async function buildHandler(basename) {
  if (!existsSync(serverEntry) || !existsSync(clientDir)) {
    throw new Error(
      '@workflow/web has not been built (missing build/). ' +
        'Run `pnpm --filter @workflow/web build` before embedding the dashboard.'
    );
  }

  const mod = await import(pathToFileURL(serverEntry).href);
  if (typeof mod.createFetchHandler !== 'function') {
    throw new Error(
      '@workflow/web build does not export createFetchHandler; rebuild the package.'
    );
  }
  const ssr = mod.createFetchHandler(basename || '/');
  const serveStatic = createStaticHandler({
    dir: clientDir,
    basename,
    // The host owns the connection and may compress the response itself. Even
    // where it doesn't, this runs inside someone else's process — spending its
    // CPU and libuv threads on brotli for what is almost always a localhost
    // dev server is a bad trade. `server.js` leaves compression on, since it
    // can be self-hosted over a real network.
    compress: false,
  });

  return async (request) => {
    // Advertise this dashboard so the CLI can defer to it (best-effort, once).
    // Done on first request because that's when the public origin is known.
    try {
      const origin = new URL(request.url).origin;
      recordDashboard({
        url: origin + basename,
        basename,
        world:
          process.env.WORKFLOW_TARGET_WORLD ||
          (process.env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local'),
      });
    } catch {
      // ignore — registration must never affect request handling
    }

    const staticResponse = await serveStatic(request);
    if (staticResponse) return staticResponse;
    return ssr(request);
  };
}
