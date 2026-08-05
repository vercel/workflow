/**
 * Static file serving for the prebuilt client bundle (`build/client`), shared
 * by both ways @workflow/web is served:
 *
 * - `server.js` — the standalone server, mounted at the root.
 * - `handler.js` — the embedded handler, mounted under a base path inside
 *   another server.
 *
 * Internal: this file ships in the package (both consumers import it
 * relatively) but is deliberately absent from the `exports` map, so it is not
 * part of the public API.
 */

import { staticMiddleware } from 'srvx/static';

const ONE_YEAR_SECONDS = 31_536_000;
const ONE_HOUR_SECONDS = 3600;

/**
 * Sentinel handed to `staticMiddleware` as its `next()`. Returned by identity
 * when no file matched, so a miss is distinguishable from a real 404 the
 * middleware itself produced. Never sent to a client.
 */
const MISS = new Response(null, { status: 404 });

/**
 * Build a static file handler for `dir`.
 *
 * Two middlewares over the same directory, differing only in freshness policy:
 * everything under `/assets/` is content-hashed by Vite (its URL changes when
 * its bytes do) and can be cached indefinitely without revalidation, while the
 * rest — `favicon.ico` and anything else copied from `public/` — keeps a stable
 * URL and so gets a short lifetime. Both emit ETag/Last-Modified validators
 * regardless, so a stale client revalidates into a 304 rather than a full body.
 *
 * @param {object} options
 * @param {string} options.dir - Directory to serve from (the client build).
 * @param {string} [options.basename] - Mount prefix to strip before resolving,
 *   already normalized (no trailing slash; `""` for the root).
 * @param {boolean} [options.compress] - Compress compressible bodies on the
 *   fly. Defaults to true.
 * @returns {(request: Request) => Promise<Response | null>} The response, or
 *   `null` when the request maps to no file and should fall through to SSR.
 */
export function createStaticHandler({ dir, basename = '', compress = true }) {
  const hashedAssets = staticMiddleware({
    dir,
    maxAge: ONE_YEAR_SECONDS,
    immutable: true,
    compress,
  });
  const publicFiles = staticMiddleware({
    dir,
    maxAge: ONE_HOUR_SECONDS,
    compress,
  });

  return async (request) => {
    // Everything else (including the index) is the SSR handler's.
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }

    let target = request;
    if (basename) {
      // A request at exactly `basename` is the dashboard index, not a file.
      if (!url.pathname.startsWith(`${basename}/`)) return null;
      url.pathname = url.pathname.slice(basename.length);
      // `staticMiddleware` resolves against the request's own pathname, so the
      // mount prefix has to come off the URL rather than be passed alongside.
      // Safe to rebuild for GET/HEAD, which carry no body.
      target = new Request(url, request);
    }

    const middleware = url.pathname.startsWith('/assets/')
      ? hashedAssets
      : publicFiles;
    const response = await middleware(target, () => MISS);
    return response === MISS ? null : response;
  };
}
