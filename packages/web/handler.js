/**
 * Framework-agnostic, in-process entry point for @workflow/web.
 *
 * Unlike `server.js` (which starts a standalone Express HTTP server), this
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
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordDashboard } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, 'build');
const clientDir = path.join(buildDir, 'client');
const serverEntry = path.join(buildDir, 'server', 'index.js');

// Minimal extension -> MIME map for serving the static client build. A wrong
// Content-Type on the entry module breaks the whole app, so be explicit.
const MIME_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

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

    const staticResponse = await tryServeStatic(request, basename);
    if (staticResponse) return staticResponse;
    return ssr(request);
  };
}

/**
 * Resolve a request to a path-within-the-client-build (relative to `clientDir`),
 * stripping `basename` and guarding against traversal. Returns null when the
 * request can't map to a client file (so it should fall through to the SSR
 * handler) — e.g. the index, a directory, or an out-of-tree path.
 */
function resolveClientFile(request, basename) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }

  if (basename) {
    if (!pathname.startsWith(`${basename}/`)) return null; // index/other -> SSR
    pathname = pathname.slice(basename.length);
  }

  const relative = pathname.replace(/^\/+/, '');
  if (!relative || relative.endsWith('/')) return null;

  const filePath = path.join(clientDir, relative);
  // Guard against path traversal escaping the client build directory.
  if (filePath !== clientDir && !filePath.startsWith(clientDir + path.sep)) {
    return null;
  }
  return { filePath, relative };
}

/**
 * Serve a file from the prebuilt client bundle if the request maps to one;
 * otherwise return null so the request falls through to the SSR handler.
 */
async function tryServeStatic(request, basename) {
  const resolved = resolveClientFile(request, basename);
  if (!resolved) return null;
  const { filePath, relative } = resolved;

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const ext = path.extname(filePath).toLowerCase();
  const headers = new Headers({
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    // Hashed assets are content-addressed and safe to cache forever; other
    // client files (e.g. favicon) get a short cache.
    'Cache-Control': relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600',
  });

  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(stats.size));
    return new Response(null, { status: 200, headers });
  }

  const body = await readFile(filePath);
  return new Response(body, { status: 200, headers });
}
