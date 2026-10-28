/**
 * Production server entry point for @workflow/web.
 *
 * Can be invoked directly for self-hosting:
 *   node server.js
 *
 * Or imported by the CLI for in-process serving:
 *   import { startServer } from "@workflow/web/server"
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from 'srvx';
import { createStaticHandler } from './static.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, 'build');
const clientDir = path.join(buildDir, 'client');
const serverEntry = path.join(buildDir, 'server', 'index.js');

/**
 * Start the production HTTP server.
 *
 * @param {number} [port] - Port to listen on. Defaults to PORT env or 3000.
 * @returns {Promise<import("srvx").Server>} The listening server. The
 *   underlying Node `http.Server` remains reachable via `server.node.server`.
 */
export async function startServer(port) {
  // Import the compiled server build, which exports `createFetchHandler` (the
  // React Router request handler, as a Web `Request` -> `Response` function).
  const { createFetchHandler } = await import(pathToFileURL(serverEntry).href);

  // Static assets are resolved before the SSR handler ever runs. Compression is
  // left on here (unlike the embedded handler): this server can be self-hosted
  // over a real network, where trading CPU for bytes is worth it.
  const serveStatic = createStaticHandler({ dir: clientDir });
  const ssr = createFetchHandler('/');

  const server = serve({
    port: port ?? parseInt(process.env.PORT || '3000', 10),
    async fetch(request) {
      return (await serveStatic(request)) ?? ssr(request);
    },
    // Safety net — prevents an unhandled error from taking down the server when
    // the React Router error boundary cannot render (e.g. during SSR).
    error(error) {
      console.error('Unhandled request error:', error);
      return new Response('Internal Server Error', { status: 500 });
    },
    // We print our own listening line below.
    silent: true,
  });

  await server.ready();
  console.log(`@workflow/web server listening on ${server.url}`);
  return server;
}

// When run directly, start the server
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
