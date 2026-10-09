import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { JsonTransport } from '@vercel/queue';
import { getQueueTopicPrefix, MessageId } from '@workflow/world';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { MessageData } from '../src/message.js';
import { createQueue, type PostgresQueue } from '../src/queue.js';

/**
 * graphile-worker 0.16 sets a job's `locked_at` once, at claim, and only
 * resets locks older than a fixed 4 hours. These tests run real Graphile
 * Workers against a real Postgres to pin down that a running delivery renews
 * its lock and that a job whose holder died is redelivered by another process
 * after `jobLockStaleSeconds`, not after 4 hours or a restart.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue job lock renewal (real database and Graphile)',
  () => {
    const STALE_SECONDS = 2;
    const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let connectionString: string;
    let pool: Pool;
    let server: Server;
    let deliveries: Array<{ attempt: string; executorJob?: string }> = [];
    let respond: (response: ServerResponse) => void = (response) =>
      response.end('{}');
    let releaseHeldResponses = () => {};
    const queues: PostgresQueue[] = [];
    const children: ChildProcess[] = [];

    function startQueue(config: Partial<Parameters<typeof createQueue>[0]>) {
      const queue = createQueue(
        {
          connectionString,
          queueConcurrency: 1,
          applicationManagedShutdown: true,
          jobLockStaleSeconds: STALE_SECONDS,
          ...config,
        } as Parameters<typeof createQueue>[0],
        pool
      );
      queues.push(queue);
      return queue;
    }

    async function jobRows() {
      return (
        await pool.query<{
          id: string;
          task_identifier: string;
          attempts: number;
          locked_by: string | null;
          locked_at: Date | null;
        }>(
          'SELECT id, task_identifier, attempts, locked_by, locked_at FROM graphile_worker.jobs ORDER BY id'
        )
      ).rows;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      pool = new Pool({ connectionString, max: 10 });
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      await utils.release();
      server = createServer(async (request, response) => {
        await request.toArray();
        const executorJob = request.headers['x-workflow-postgres-executor-job'];
        deliveries.push({
          attempt: String(request.headers['x-vqs-message-attempt']),
          ...(typeof executorJob === 'string' ? { executorJob } : {}),
        });
        respond(response);
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

    afterEach(async () => {
      releaseHeldResponses();
      for (const child of children.splice(0)) child.kill('SIGKILL');
      await Promise.all(queues.splice(0).map((queue) => queue.close()));
      await pool.query(
        'TRUNCATE graphile_worker._private_jobs, graphile_worker._private_job_queues'
      );
      deliveries = [];
      respond = (response) => response.end('{}');
      releaseHeldResponses = () => {};
    });

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

    test('another host redelivers the job of a worker that died mid-delivery', async () => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./fixtures/crashing-queue.mjs', import.meta.url)
          ),
        ],
        {
          env: {
            ...process.env,
            DEBUG: '',
            WORKFLOW_POSTGRES_URL: connectionString,
          },
          stdio: ['ignore', 'pipe', 'inherit'],
        }
      );
      children.push(child);
      const exited = once(child, 'exit');
      let messageId: string | undefined;
      if (!child.stdout) throw new Error('Expected piped stdout');
      for await (const line of createInterface({ input: child.stdout })) {
        const match = /^claimed (\S+)$/.exec(line);
        if (match) {
          messageId = match[1];
          break;
        }
      }
      expect(messageId).toMatch(/^msg_/);
      child.kill('SIGKILL');
      await exited;

      const [orphan] = await jobRows();
      expect(orphan).toMatchObject({ attempts: 1 });
      expect(orphan.locked_by).not.toBeNull();

      // A live host, as on a multi-host deployment: nothing restarts, and
      // nothing re-enqueues the run.
      await startQueue({}).start();

      await expect
        .poll(() => deliveries, { timeout: 15_000, interval: 100 })
        .toEqual([{ attempt: '2' }]);
      await expect.poll(jobRows, { timeout: 5_000, interval: 100 }).toEqual([]);
    }, 30_000);

    test('a delivery that outlives the stale window keeps its lock and is delivered once', async () => {
      const release = Promise.withResolvers<void>();
      releaseHeldResponses = release.resolve;
      respond = (response) => {
        release.promise.then(() => response.end('{}'));
      };
      const first = startQueue({});
      // A second host whose sweeps would release the job if its lock went stale.
      const second = startQueue({});
      await Promise.all([first.start(), second.start()]);

      await first.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: 'wrun_long_delivery',
      });
      await expect
        .poll(() => deliveries.length, { timeout: 5_000, interval: 50 })
        .toBe(1);
      const [claimed] = await jobRows();
      expect(claimed.locked_at).not.toBeNull();

      // Hold the delivery for three stale windows.
      await new Promise((resolve) =>
        setTimeout(resolve, STALE_SECONDS * 3 * 1000)
      );
      const [held] = await jobRows();
      expect(held).toMatchObject({
        id: claimed.id,
        attempts: 1,
        locked_by: claimed.locked_by,
      });
      expect((held.locked_at as Date).getTime()).toBeGreaterThan(
        (claimed.locked_at as Date).getTime() + STALE_SECONDS * 1000
      );

      release.resolve();
      await expect.poll(jobRows, { timeout: 5_000, interval: 100 }).toEqual([]);
      expect(deliveries).toEqual([{ attempt: '1' }]);
    }, 30_000);

    test("a delivery that lost its lock leaves the successor's job alone when it finishes", async () => {
      const release = Promise.withResolvers<void>();
      releaseHeldResponses = release.resolve;
      respond = (response) => {
        release.promise.then(() => response.end('{}'));
      };
      const queue = startQueue({});
      await queue.start();
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: 'wrun_lost_lock',
      });
      await expect
        .poll(() => deliveries.length, { timeout: 5_000, interval: 50 })
        .toBe(1);
      const [claimed] = await jobRows();

      // Another worker holds the job now, as after a release while this
      // holder's renewals stalled. Its lock is fresh for the whole test.
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET locked_by = 'worker-successor',
           locked_at = now() + interval '1 hour' WHERE id = $1`,
        [claimed.id]
      );
      // Let a renewal (every quarter window) find the lock gone.
      await new Promise((resolve) =>
        setTimeout(resolve, (STALE_SECONDS * 1000) / 2)
      );
      release.resolve();
      // close() waits for the runner to finish the delivery.
      await queue.close();

      // Graphile Worker completes a job with a delete by id alone; failing is
      // fenced on the holder. The successor's row must survive.
      expect(await jobRows()).toMatchObject([
        { id: claimed.id, attempts: 1, locked_by: 'worker-successor' },
      ]);
      expect(deliveries).toEqual([{ attempt: '1' }]);
    }, 30_000);

    test("releases a dead executor's job and its per-run queue lock in invoke mode, and only this World's jobs", async () => {
      const runId = 'wrun_dead_executor';
      const transport = new JsonTransport();
      const utils = await makeWorkerUtils({ pgPool: pool });
      try {
        await utils.addJob(
          'workflow_flows_executor',
          MessageData.encode({
            id: 'test',
            data: transport.serialize({ runId }),
            attempt: 1,
            messageId: MessageId.parse('msg_01DEADEXECUTOR'),
          }),
          { queueName: `workflow_flows:${runId}:executor`, maxAttempts: 73 }
        );
        await utils.addJob('other_app_task', {}, { maxAttempts: 5 });
      } finally {
        await utils.release();
      }
      // Both were claimed by a worker that died an hour ago: within Graphile
      // Worker's own 4 hour window, so only the World can release them.
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET attempts = 1,
           locked_by = 'worker-dead', locked_at = now() - interval '1 hour'`
      );
      await pool.query(
        `UPDATE graphile_worker._private_job_queues SET
           locked_by = 'worker-dead', locked_at = now() - interval '1 hour'`
      );
      const [executorJob] = (await jobRows()).filter(
        (job) => job.task_identifier === 'workflow_flows_executor'
      );

      await startQueue({ enableInvoke: true }).start();

      await expect
        .poll(() => deliveries, { timeout: 15_000, interval: 100 })
        .toEqual([{ attempt: '2', executorJob: executorJob.id }]);
      await expect
        .poll(
          async () =>
            (await jobRows()).map(({ task_identifier, locked_by }) => ({
              task_identifier,
              locked_by,
            })),
          { timeout: 5_000, interval: 100 }
        )
        .toEqual([
          { task_identifier: 'other_app_task', locked_by: 'worker-dead' },
        ]);
      const queueLocks = await pool.query(
        'SELECT queue_name, locked_by FROM graphile_worker._private_job_queues'
      );
      expect(queueLocks.rows).toEqual([
        { queue_name: `workflow_flows:${runId}:executor`, locked_by: null },
      ]);
    }, 30_000);
  }
);
