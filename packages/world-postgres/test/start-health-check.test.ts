import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  IN_PROCESS_WORKER_STATE,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import {
  getQueueTopicPrefix,
  IN_PROCESS_QUEUE_HANDLER,
  type QueueRouteHandler,
} from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
// These integration tests exercise the built runtime, like the conformance suite.
import {
  healthCheck,
  setWorld,
  workflowEntrypoint,
} from '../../core/dist/runtime.js';
import { createWorld } from '../src/index.js';
import { createQueue } from '../src/queue.js';
import { TestPool } from './pool.js';

/**
 * `start()` gets the app's flow route with no startup code in the app: it
 * marks the process as the one that wants the route, then sends one health
 * check to the app's own flow route. The framework loads the route module to
 * answer it, and the route hands itself to the World, which starts the
 * runner. The server usually does not listen yet when its startup hook calls
 * `start()`, so the check is retried until it connects.
 */

const code = `globalThis.__private_workflows = new Map();`;

/** Serves `handle` over HTTP as a framework would, on a port it reports. */
function createAppServer(
  handle: (request: Request) => Promise<Response>
): Server {
  return createServer(async (req, res) => {
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : Buffer.concat(await req.toArray());
    const response = await handle(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
      })
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
}

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

const isHealthCheck = (request: Request) =>
  new URL(request.url).searchParams.has('__health');

describe.skipIf(process.platform === 'win32')(
  'Postgres World start(): the health check to its own flow route (integration)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let connectionString: string;
    const servers: Server[] = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      pool = new TestPool({ connectionString, max: 8 });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(
          new URL('../src/drizzle/migrations', import.meta.url)
        ),
        migrationsTable: 'workflow_migrations',
        migrationsSchema: 'workflow_drizzle',
      });
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      await utils.release();
    }, 120_000);

    afterEach(async () => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      setWorld(undefined);
      await Promise.all(servers.splice(0).map(closeServer));
      resetGlobalSingletonForTest(
        IN_PROCESS_WORKER_STATE.name,
        IN_PROCESS_WORKER_STATE.shapeVersion
      );
    });

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    it('a server that only calls start() runs jobs: its flow route registers itself on the health check', async () => {
      const world = createWorld({ pool, applicationManagedShutdown: true });
      setWorld(world);
      // The framework loads the route module on the first request to it, as
      // `next dev` compiles it and `next start` evaluates it.
      let route: QueueRouteHandler | undefined;
      const requests: string[] = [];
      const server = createAppServer(async (request) => {
        requests.push(new URL(request.url).search);
        route ??= workflowEntrypoint(code);
        return route(request);
      });
      servers.push(server);
      const port = await freePort();
      vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', `http://127.0.0.1:${port}`);
      try {
        // The startup hook runs before the server listens.
        await world.start();
        expect(route).toBeUndefined();
        await sleep(300);
        await listen(server, port);

        // A message enqueued now is run by this process's worker, in
        // process, through the route that registered itself.
        const result = await healthCheck(world, { timeout: 15_000 });
        expect(result).toMatchObject({ healthy: true });
        // One health check reached the route; nothing else went over HTTP.
        expect(requests).toEqual(['?__health']);
        expect(route).toBeDefined();
        expect(typeof route?.[IN_PROCESS_QUEUE_HANDLER]).toBe('function');
      } finally {
        await world.close?.();
      }
    }, 60_000);

    it('warns once, and runs no worker, when the URL answers without registering the route', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let healthChecks = 0;
      // Answers the health check, but is not this process's route: another
      // process, or a runtime that predates the self-registration.
      const server = createAppServer(async (request) => {
        if (isHealthCheck(request)) healthChecks++;
        return Response.json({ healthy: true });
      });
      servers.push(server);
      const port = await listen(server);
      vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', `http://127.0.0.1:${port}`);
      const queue = createQueue(
        { connectionString, applicationManagedShutdown: true },
        pool
      );
      try {
        await queue.start();
        await vi.waitFor(() =>
          expect(
            warn.mock.calls.filter((call) =>
              String(call[0]).includes('did not register in this process')
            )
          ).toHaveLength(1)
        );
        expect(healthChecks).toBe(1);
        // A later publish is not told again.
        await queue.queue(`${getQueueTopicPrefix('workflow')}noop`, {
          runId: 'wrun_none',
        });
        expect(
          warn.mock.calls.filter((call) =>
            String(call[0]).includes('runs no jobs')
          )
        ).toHaveLength(1);
      } finally {
        await queue.close();
        await pool.query('TRUNCATE graphile_worker._private_jobs');
      }
    }, 30_000);

    it('gives up after its window when nothing answers, and says so once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv(
        'WORKFLOW_LOCAL_BASE_URL',
        `http://127.0.0.1:${await freePort()}`
      );
      const queue = createQueue(
        { connectionString, applicationManagedShutdown: true },
        pool,
        { startHealthCheckWindowMs: 500 }
      );
      try {
        await queue.start();
        await vi.waitFor(() =>
          expect(
            warn.mock.calls.filter((call) =>
              String(call[0]).includes('did not succeed within 500 ms')
            )
          ).toHaveLength(1)
        );
      } finally {
        await queue.close();
      }
    }, 30_000);

    it('stops sending once the route is registered another way while it retries', async () => {
      let healthChecks = 0;
      const server = createAppServer(async () => {
        healthChecks++;
        return Response.json({ healthy: true });
      });
      servers.push(server);
      const port = await freePort();
      vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', `http://127.0.0.1:${port}`);
      const queue = createQueue(
        { connectionString, applicationManagedShutdown: true },
        pool
      );
      try {
        await queue.start();
        // Retrying: nothing listens yet. The route is handed over directly
        // (registerWorkflowHandler() in a process that serves no HTTP).
        await sleep(300);
        queue.registerHandler(
          getQueueTopicPrefix('workflow'),
          Object.assign(async () => Response.json({}), {
            [IN_PROCESS_QUEUE_HANDLER]: async () => undefined,
          })
        );
        await listen(server, port);
        // Longer than the retry backoff at this point.
        await sleep(1_500);
        expect(healthChecks).toBe(0);
      } finally {
        await queue.close();
      }
    }, 30_000);

    it('close() stops a health check that is still retrying', async () => {
      vi.stubEnv(
        'WORKFLOW_LOCAL_BASE_URL',
        `http://127.0.0.1:${await freePort()}`
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const queue = createQueue(
        { connectionString, applicationManagedShutdown: true },
        pool
      );
      await queue.start();
      await sleep(300);
      const startedAt = Date.now();
      await queue.close();
      // Not held up by the two-minute window or a backoff delay.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(warn).not.toHaveBeenCalled();
    }, 30_000);
  }
);
