import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  getQueueTopicPrefix,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { makeWorkerUtils } from 'graphile-worker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createQueue, type PostgresQueue } from '../src/queue.js';
import { TestPool } from './pool.js';

/**
 * Cluster mode (PM2 `-i N`, `node:cluster`, several containers): every
 * process of the app registers the flow handler and runs a worker, and a
 * message enqueued by any process (an app process, the CLI, a script) is
 * delivered in exactly one of them, in process. Real Graphile Workers
 * against a real Postgres; the "processes" here are queues sharing one
 * database, each with its own registered handler.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue in cluster mode (integration)',
  () => {
    const prefix = getQueueTopicPrefix('workflow');
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let connectionString: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      pool = new TestPool({ connectionString, max: 12 });
      // Graphile's schema, installed once: on a deployment `bootstrap` has
      // run before the processes start, and `start()` only checks it.
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      await utils.release();
    }, 120_000);

    afterAll(async () => {
      await pool.end();
      await container.stop();
    });

    test('every message is delivered once, to a process that registered the handler', async () => {
      const WORKERS = 3;
      const MESSAGES = 30;
      /** Deliveries by worker: the run ids each one handled. */
      const delivered = Array.from({ length: WORKERS }, () => [] as string[]);
      const workers: PostgresQueue[] = [];
      for (let i = 0; i < WORKERS; i++) {
        const worker = createQueue(
          {
            connectionString,
            queueConcurrency: 2,
            pollInterval: 50,
            applicationManagedShutdown: true,
          },
          pool
        );
        worker.registerHandler(prefix, async (request) => {
          const { runId } = JSON.parse(await request.text()) as {
            runId: string;
          };
          delivered[i].push(runId);
          return Response.json({ ok: true });
        });
        workers.push(worker);
      }
      // The producer registered nothing: a script or the CLI.
      const producer = createQueue(
        { connectionString, applicationManagedShutdown: true },
        pool
      );
      try {
        await Promise.all(workers.map((worker) => worker.start()));
        const runIds = Array.from(
          { length: MESSAGES },
          () => `wrun_${randomUUID()}`
        );
        await Promise.all(
          runIds.map((runId, index) =>
            producer.queue(`${prefix}cluster`, {
              runId,
              // Half single-orchestrator runs (serialized per run through
              // their named queue), half spec 8.
              ...(index % 2 === 0
                ? { runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR }
                : {}),
            })
          )
        );

        await expect
          .poll(() => delivered.flat().length, { timeout: 20_000 })
          .toBe(MESSAGES);
        expect(delivered.flat().sort()).toEqual([...runIds].sort());
        // Every job was taken, and nothing is left to redeliver.
        await expect
          .poll(
            async () =>
              (
                await pool.query(
                  'SELECT count(*)::int AS count FROM graphile_worker._private_jobs'
                )
              ).rows[0].count,
            { timeout: 5_000 }
          )
          .toBe(0);
      } finally {
        await producer.close();
        await Promise.all(workers.map((worker) => worker.close()));
      }
    }, 60_000);
  }
);
