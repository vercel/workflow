import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { getQueueTopicPrefix } from '@workflow/world';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createQueue, type PostgresQueue } from '../src/queue.js';

/**
 * Processes sharing the database with different stale windows, as while
 * `jobLockStaleSeconds` is being changed across them. A delivery released by
 * the process with the shorter window must not be acknowledged by its
 * original holder when it finishes, however recently that holder's last
 * renewal succeeded: Graphile Worker's acknowledgement is not fenced on the
 * lock holder, so it would delete the redelivery's row, and a failure of the
 * redelivery would then never be retried.
 *
 * Host A (this process): default policy, window shortened to 60s through the
 * test hook. Its delivery blocks its event loop for {@link SYNC_STRETCH_MS}.
 * Host B (`fixtures/short-window-host.mjs`, its own process):
 * `jobLockStaleSeconds: 1`.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue job lease across processes with different stale windows (real database and Graphile)',
  () => {
    const SYNC_STRETCH_MS = 6_000;
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let connectionString: string;
    let pool: Pool;
    let server: Server;
    let queue: PostgresQueue | undefined;
    let hostB: ChildProcess | undefined;
    const hostBLines: string[] = [];
    let onDelivery: (response: ServerResponse) => void = (response) =>
      response.end('{}');
    const deliveries: string[] = [];

    async function jobRows() {
      return (
        await pool.query<{ id: string; attempts: number; locked_by: string }>(
          'SELECT id, attempts, locked_by FROM graphile_worker.jobs ORDER BY id'
        )
      ).rows;
    }

    async function waitForHostB(pattern: RegExp, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!hostBLines.some((line) => pattern.test(line))) {
        if (Date.now() > deadline) {
          throw new Error(
            `Host B never printed ${pattern}; it printed: ${JSON.stringify(hostBLines)}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    beforeAll(async () => {
      delete process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS;
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      pool = new Pool({ connectionString, max: 10 });
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      await utils.release();
      // The holder table, as `bootstrap` creates it (migration 0030).
      await pool.query('CREATE SCHEMA IF NOT EXISTS workflow');
      await pool.query(
        await readFile(
          new URL(
            '../src/drizzle/migrations/0030_add_job_lock_holders.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
      server = createServer(async (request, response) => {
        await request.toArray();
        deliveries.push(String(request.headers['x-vqs-message-attempt']));
        onDelivery(response);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP server');
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;

      hostB = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./fixtures/short-window-host.mjs', import.meta.url)
          ),
        ],
        {
          env: {
            ...process.env,
            DEBUG: '',
            WORKFLOW_POSTGRES_URL: connectionString,
            SHORT_WINDOW_STALE_SECONDS: '1',
          },
          stdio: ['pipe', 'pipe', 'inherit'],
        }
      );
      if (!hostB.stdout) throw new Error('Expected piped stdout');
      createInterface({ input: hostB.stdout }).on('line', (line) =>
        hostBLines.push(line)
      );
      await waitForHostB(/^listening$/);
    }, 120_000);

    afterAll(async () => {
      vi.restoreAllMocks();
      if (hostB) {
        const exited = once(hostB, 'exit');
        hostB.kill('SIGKILL');
        await exited;
      }
      await queue?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await pool.end();
      await container.stop();
    });

    test('a delivery released by a process with a shorter window is not acknowledged, and its redelivery keeps its retry', async () => {
      const warn = vi.spyOn(console, 'warn');
      const firstDelivery = Promise.withResolvers<void>();
      onDelivery = (response) => {
        if (deliveries.length > 1) {
          response.end('{}');
          return;
        }
        firstDelivery.resolve();
        // Start host B only now, so that host A claims the job.
        hostB!.stdin!.write('start\n');
        void waitForHostB(/^ready$/).then(() => {
          // A synchronous stretch (an inline step, say): host A's renewal
          // timer cannot fire, but host B keeps releasing stale locks.
          const until = Date.now() + SYNC_STRETCH_MS;
          while (Date.now() < until) {}
          response.end('{}');
        });
      };

      queue = createQueue(
        {
          connectionString,
          queueConcurrency: 1,
          applicationManagedShutdown: true,
        },
        pool,
        { defaultJobLockStaleSeconds: 60 }
      );
      await queue.start();
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: 'wrun_mixed_windows',
      } as never);
      await firstDelivery.promise;

      // Host B released the job during the stretch and redelivered it.
      await waitForHostB(/^claimed 2$/);
      expect(deliveries).toEqual(['1']);

      // Host A finished well within half its own window, yet checked its
      // lock, found it gone, and did not acknowledge: the row stays with B.
      await expect
        .poll(
          () =>
            warn.mock.calls.some((args) =>
              String(args[0]).includes('Lost the lock on Graphile job')
            ),
          { timeout: 10_000, interval: 100 }
        )
        .toBe(true);
      const [heldByB] = await jobRows();
      expect(heldByB).toMatchObject({ attempts: 2 });
      expect(heldByB!.locked_by).not.toBeNull();

      // The redelivery fails, and is retried.
      hostB!.stdin!.write('fail\n');
      await waitForHostB(/^responded 500$/);
      await expect
        .poll(
          () => deliveries.includes('3') || hostBLines.includes('claimed 3'),
          { timeout: 30_000, interval: 200 }
        )
        .toBe(true);
    }, 90_000);
  }
);
