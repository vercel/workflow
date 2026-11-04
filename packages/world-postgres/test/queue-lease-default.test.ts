import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  getQueueTopicPrefix,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createQueue, type PostgresQueue } from '../src/queue.js';

/**
 * The default job-lease policy, with neither `jobLockStaleSeconds` nor
 * `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS` set: every delivery renews its
 * lock and registers its worker as renewing, and the sweep releases only the
 * jobs of a spec 9 run's named queue whose holder registered. Real Graphile
 * Workers against a real Postgres; the default window is shortened to
 * {@link STALE_SECONDS} through the queue's test hook.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue default job lease for spec 9 named queues (real database and Graphile)',
  () => {
    const STALE_SECONDS = 2;
    const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    const originalStaleEnv =
      process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS;
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let connectionString: string;
    let pool: Pool;
    let server: Server;
    let deliveries: Array<{ attempt: string }> = [];
    let respond: (response: ServerResponse) => void = (response) =>
      response.end('{}');
    let releaseHeldResponses = () => {};
    const queues: PostgresQueue[] = [];
    const children: ChildProcess[] = [];

    /** A live host on the default policy, with a short default window. */
    function startQueue() {
      const queue = createQueue(
        {
          connectionString,
          queueConcurrency: 1,
          applicationManagedShutdown: true,
        },
        pool,
        { defaultJobLockStaleSeconds: STALE_SECONDS }
      );
      queues.push(queue);
      return queue;
    }

    async function jobRows() {
      return (
        await pool.query<{
          id: string;
          attempts: number;
          queue_name: string | null;
          locked_by: string | null;
          locked_at: Date | null;
        }>(
          'SELECT id, attempts, queue_name, locked_by, locked_at FROM graphile_worker.jobs ORDER BY id'
        )
      ).rows;
    }

    async function holders() {
      return (
        await pool.query<{ worker_id: string }>(
          'SELECT worker_id FROM workflow.workflow_job_lock_holders'
        )
      ).rows.map((row) => row.worker_id);
    }

    /**
     * Runs `crashing-queue.mjs`, which claims one delivery and holds it, and
     * SIGKILLs it once the claim is in. Returns the orphaned job.
     */
    async function orphanJob(env: Record<string, string>) {
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
            ...env,
          },
          stdio: ['ignore', 'pipe', 'inherit'],
        }
      );
      children.push(child);
      const exited = once(child, 'exit');
      if (!child.stdout) throw new Error('Expected piped stdout');
      let claimed = false;
      for await (const line of createInterface({ input: child.stdout })) {
        if (/^claimed (\S+)$/.test(line)) {
          claimed = true;
          break;
        }
      }
      expect(claimed).toBe(true);
      child.kill('SIGKILL');
      await exited;
      const [orphan] = await jobRows();
      expect(orphan).toMatchObject({ attempts: 1 });
      expect(orphan!.locked_by).not.toBeNull();
      return orphan!;
    }

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

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
        deliveries.push({
          attempt: String(request.headers['x-vqs-message-attempt']),
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
        'TRUNCATE graphile_worker._private_jobs, graphile_worker._private_job_queues, workflow.workflow_job_lock_holders'
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
      if (originalStaleEnv !== undefined) {
        process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS = originalStaleEnv;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await pool.end();
      await container.stop();
    });

    test("another host wakes a SIGKILLed worker's spec 9 run within the window", async () => {
      const runId = 'wrun_default_killed';
      const orphan = await orphanJob({
        CRASHING_QUEUE_RUN_ID: runId,
        CRASHING_QUEUE_RUN_SPEC_VERSION: String(
          SPEC_VERSION_SINGLE_ORCHESTRATOR
        ),
      });
      expect(orphan.queue_name).toBe(`workflow_flows:${runId}:executor`);
      // The dead worker registered as renewing before its delivery ran.
      expect(await holders()).toContain(orphan.locked_by);

      // A live host on the default policy: nothing restarts, and nothing
      // re-enqueues the run.
      await startQueue().start();

      await expect
        .poll(() => deliveries, { timeout: 15_000, interval: 100 })
        .toEqual([{ attempt: '2' }]);
      await expect.poll(jobRows, { timeout: 5_000, interval: 100 }).toEqual([]);
    }, 30_000);

    test('a live slow spec 9 delivery that renews is not released', async () => {
      const release = Promise.withResolvers<void>();
      releaseHeldResponses = release.resolve;
      respond = (response) => {
        release.promise.then(() => response.end('{}'));
      };
      const first = startQueue();
      // A second host whose sweeps would release the job if its lock went
      // stale.
      const second = startQueue();
      await Promise.all([first.start(), second.start()]);

      await first.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: 'wrun_default_slow',
        runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      } as never);
      await expect
        .poll(() => deliveries.length, { timeout: 5_000, interval: 50 })
        .toBe(1);
      const [claimed] = await jobRows();
      expect(claimed!.queue_name).toBe(
        'workflow_flows:wrun_default_slow:executor'
      );

      // Hold the delivery for three stale windows.
      await sleep(STALE_SECONDS * 3 * 1000);
      const [held] = await jobRows();
      expect(held).toMatchObject({
        id: claimed!.id,
        attempts: 1,
        locked_by: claimed!.locked_by,
      });
      expect((held!.locked_at as Date).getTime()).toBeGreaterThan(
        (claimed!.locked_at as Date).getTime() + STALE_SECONDS * 1000
      );

      release.resolve();
      await expect.poll(jobRows, { timeout: 5_000, interval: 100 }).toEqual([]);
      expect(deliveries).toEqual([{ attempt: '1' }]);
    }, 30_000);

    test('leaves the spec 9 job of a holder that does not renew (an earlier version) locked', async () => {
      // `jobLockStaleSeconds: 0` behaves as a 5.1.0 process on its default:
      // it neither renews nor registers.
      const orphan = await orphanJob({
        CRASHING_QUEUE_RUN_ID: 'wrun_default_old_holder',
        CRASHING_QUEUE_RUN_SPEC_VERSION: String(
          SPEC_VERSION_SINGLE_ORCHESTRATOR
        ),
        CRASHING_QUEUE_STALE_SECONDS: '0',
      });
      expect(await holders()).not.toContain(orphan.locked_by);

      await startQueue().start();
      // Several sweeps past the window.
      await sleep(STALE_SECONDS * 4 * 1000);

      expect(deliveries).toEqual([]);
      expect(await jobRows()).toMatchObject([
        { id: orphan.id, attempts: 1, locked_by: orphan.locked_by },
      ]);
    }, 30_000);

    test('leaves a registered holder’s job outside the named queues locked', async () => {
      // A spec 8 message: no named queue, so the default sweep does not
      // cover it, even though its holder renewed.
      const orphan = await orphanJob({});
      expect(orphan.queue_name).toBeNull();
      expect(await holders()).toContain(orphan.locked_by);

      await startQueue().start();
      await sleep(STALE_SECONDS * 4 * 1000);

      expect(deliveries).toEqual([]);
      expect(await jobRows()).toMatchObject([
        { id: orphan.id, attempts: 1, locked_by: orphan.locked_by },
      ]);
    }, 30_000);
  }
);
