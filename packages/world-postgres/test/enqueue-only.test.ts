import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  getQueueTopicPrefix,
  IN_PROCESS_QUEUE_HANDLER,
  type InProcessDelivery,
} from '@workflow/world';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createQueue } from '../src/queue.js';
import { TestPool } from './pool.js';

/**
 * A Graphile Worker runner starts only in a process that registered the
 * Workflow SDK's flow handler (`registerHandler`). Every other process (the
 * CLI, the web UI, a script or a test runner calling `start()`) only
 * enqueues: it never claims a job, and never delivers one over HTTP to the
 * app. The app's own process, which registered the handler, takes the job.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue: a process without the flow handler only enqueues (integration)',
  () => {
    const prefix = getQueueTopicPrefix('workflow');
    const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let connectionString: string;
    let server: Server;
    /** Requests the app's HTTP flow route received. */
    const httpDeliveries: string[] = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      pool = new TestPool({ connectionString, max: 6 });
      // Stands in for the app's HTTP flow route: an earlier world-postgres
      // delivered here from any process that called `start()`.
      server = createServer(async (request, response) => {
        await request.toArray();
        httpDeliveries.push(String(request.headers['x-vqs-message-id']));
        response.end('{}');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP server');
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      if (originalBaseUrl === undefined) {
        delete process.env.WORKFLOW_LOCAL_BASE_URL;
      } else {
        process.env.WORKFLOW_LOCAL_BASE_URL = originalBaseUrl;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await pool.end();
      await container.stop();
    });

    test('a queue that registered no handler starts no delivering worker; a registered handler takes the job', async () => {
      const producer = createQueue(
        {
          connectionString,
          queueConcurrency: 2,
          applicationManagedShutdown: true,
        },
        pool
      );
      const worker = createQueue(
        {
          connectionString,
          queueConcurrency: 2,
          applicationManagedShutdown: true,
        },
        pool
      );
      const delivered: string[] = [];
      try {
        // A script, the CLI or the web UI: `start()` (through `queue()`),
        // nothing registered.
        const { messageId } = await producer.queue(`${prefix}test`, {
          runId: `wrun_${randomUUID()}`,
        });
        // Long enough for a runner (Graphile polls every 500 ms, and
        // LISTEN/NOTIFY wakes it sooner) to have claimed and delivered it.
        await sleep(3_000);
        expect(httpDeliveries).toEqual([]);
        const job = await pool.query(
          'SELECT locked_by FROM graphile_worker._private_jobs WHERE key = $1',
          [messageId]
        );
        expect(job.rows).toHaveLength(1);
        expect(job.rows[0].locked_by).toBeNull();

        // The app: it registered the flow handler, so its runner takes the job.
        worker.registerHandler(
          prefix,
          Object.assign(async () => Response.json({ ok: true }), {
            [IN_PROCESS_QUEUE_HANDLER]: async ({ meta }: InProcessDelivery) => {
              delivered.push(String(meta.messageId));
            },
          })
        );
        await worker.start();
        await expect
          .poll(() => delivered, { timeout: 10_000 })
          .toEqual([messageId]);
        expect(httpDeliveries).toEqual([]);
      } finally {
        await producer.close();
        await worker.close();
        await pool.query('TRUNCATE graphile_worker._private_jobs');
      }
    }, 30_000);
  }
);
