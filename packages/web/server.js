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
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, 'build');

async function createApp() {
  // Import the compiled server build, which exports { app } (an Express app
  // with the React Router request handler already mounted by server/app.ts)
  const { app } = await import(path.join(buildDir, 'server/index.js'));

  // Add static file serving in front of the React Router handler.
  // We create a wrapper app so static middleware runs first.
  const server = express();

  // Serve immutable assets with long-lived cache
  server.use(
    '/assets',
    express.static(path.join(buildDir, 'client/assets'), {
      immutable: true,
      maxAge: '1y',
    })
  );

  // Serve static client files with short cache
  server.use(express.static(path.join(buildDir, 'client'), { maxAge: '1h' }));

  // Mount the React Router app
  server.use(app);

  return server;
}

/**
 * Start the production HTTP server.
 *
 * @param {number} [port] - Port to listen on. Defaults to PORT env or 3000.
 * @returns {Promise<import("http").Server>} The HTTP server instance.
 */
export async function startServer(port) {
  const resolvedPort = port ?? parseInt(process.env.PORT || '3000', 10);
  const app = await createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(resolvedPort, () => {
      console.log(`@workflow/web server listening on port ${resolvedPort}`);
      resolve(server);
    });
    server.on('error', reject);
  });
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
