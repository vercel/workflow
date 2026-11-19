import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { makeWorkerUtils, run, type WorkerUtils } from 'graphile-worker';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createLegacyJobQueues,
  REPAIRS_AFTER_REMOVAL,
} from '../src/legacy-job-queues.js';
import { TestPool } from './pool.js';

/**
 * Removing the per-run Graphile queues earlier versions left
 * (`legacy-job-queues.ts`, https://github.com/vercel/workflow/issues/5378),
 * against a real Postgres and Graphile Worker schema.
 */
describe.skipIf(process.platform === 'win32')(
  'per-run Graphile queues left by earlier versions (real database)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let utils: WorkerUtils;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new TestPool({
        connectionString: container.getConnectionUri(),
        max: 10,
      });
      utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
    }, 120_000);

    afterEach(async () => {
      await pool.query(
        'TRUNCATE graphile_worker._private_jobs, graphile_worker._private_job_queues'
      );
    });

    afterAll(async () => {
      await utils?.release();
      await pool?.end();
      await container?.stop();
    });

    const reclaimer = (
      opts: { batchSize?: number; maxBatches?: number } = {}
    ) =>
      createLegacyJobQueues(pool as any, { jobPrefix: 'workflow_', ...opts });

    /** An empty queue row, as Graphile leaves one once its last job is done. */
    async function emptyQueue(name: string, locked = false) {
      await pool.query(
        `INSERT INTO graphile_worker._private_job_queues (queue_name, locked_at, locked_by)
         VALUES ($1, CASE WHEN $2 THEN now() END, CASE WHEN $2 THEN 'worker' END)`,
        [name, locked]
      );
    }

    async function queueNames() {
      const { rows } = await pool.query<{ queue_name: string }>(
        'SELECT queue_name FROM graphile_worker._private_job_queues ORDER BY queue_name'
      );
      return rows.map((row) => row.queue_name);
    }

    async function jobQueueIds() {
      const { rows } = await pool.query<{
        task_identifier: string;
        queue_name: string | null;
        job_queue_id: number | null;
      }>(
        `SELECT tasks.identifier AS task_identifier, job_queues.queue_name, jobs.job_queue_id
           FROM graphile_worker._private_jobs AS jobs
           JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
           LEFT JOIN graphile_worker._private_job_queues AS job_queues
             ON job_queues.id = jobs.job_queue_id
          ORDER BY jobs.id`
      );
      return rows;
    }

    it("removes this World's empty, unlocked per-run queues and nothing else", async () => {
      // Left by earlier versions: an orchestrator queue, an executor queue,
      // and a pinned deployment's.
      await emptyQueue('workflow_flows:wrun_01AAA');
      await emptyQueue('workflow_flows:wrun_01BBB:executor');
      await emptyQueue('workflow_dpl-1.2@x_flows:wrun_01CCC:executor');
      // Kept: locked (a job of its queue is running), not empty, another
      // prefix's, another application's, and not a per-run queue.
      await emptyQueue('workflow_flows:wrun_01LOCKED:executor', true);
      await utils.addJob(
        'workflow_flows',
        {},
        { queueName: 'workflow_flows:wrun_01BUSY:executor' }
      );
      await emptyQueue('other_flows:wrun_01OTHER:executor');
      await emptyQueue('billing:wrun_01APP');
      await emptyQueue('workflow_flows');
      await emptyQueue('workflow_flows:wrun_01X:executor:extra');
      await emptyQueue('workflow_flowsextra:wrun_01Y');

      expect(await reclaimer().reclaim()).toEqual({ queues: 3, jobs: 0 });
      expect(await queueNames()).toEqual([
        'billing:wrun_01APP',
        'other_flows:wrun_01OTHER:executor',
        'workflow_flows',
        'workflow_flows:wrun_01BUSY:executor',
        'workflow_flows:wrun_01LOCKED:executor',
        'workflow_flows:wrun_01X:executor:extra',
        'workflow_flowsextra:wrun_01Y',
      ]);
      // Idempotent.
      expect(await reclaimer().reclaim()).toEqual({ queues: 0, jobs: 0 });
    });

    it('spreads a large backlog over several reclaims', async () => {
      await pool.query(
        `INSERT INTO graphile_worker._private_job_queues (queue_name)
         SELECT 'workflow_flows:wrun_' || n || ':executor' FROM generate_series(1, 5) AS n`
      );
      const limited = reclaimer({ batchSize: 2, maxBatches: 2 });
      expect(await limited.reclaim()).toEqual({ queues: 4, jobs: 0 });
      expect(await queueNames()).toHaveLength(1);
      expect(await limited.reclaim()).toEqual({ queues: 1, jobs: 0 });
      expect(await queueNames()).toEqual([]);
    });

    it('stops between batches once the queue is closing', async () => {
      await pool.query(
        `INSERT INTO graphile_worker._private_job_queues (queue_name)
         SELECT 'workflow_flows:wrun_' || n FROM generate_series(1, 4) AS n`
      );
      let batches = 0;
      const result = await reclaimer({ batchSize: 1, maxBatches: 10 }).reclaim(
        () => batches++ >= 2
      );
      expect(result.queues).toBe(2);
      expect(await queueNames()).toHaveLength(2);
    });

    // Graphile's `add_job` ensures the queue row exists, then inserts the job
    // with that row's id. A removal that commits between the two, before the
    // job commits, leaves the job naming a queue that is gone, which
    // `get_job` never picks up. The next reclaim moves it out of the queue.
    it('lets a job added to a queue while it was removed run', async () => {
      await emptyQueue('workflow_flows:wrun_01RACE:executor');
      const reclaim = reclaimer();
      const adder = await pool.connect();
      try {
        await adder.query('BEGIN');
        await adder.query(
          `SELECT graphile_worker.add_job('workflow_flows_executor', '{}'::json,
             queue_name => 'workflow_flows:wrun_01RACE:executor')`
        );
        // The job is not committed yet, so the queue still looks empty.
        expect(await reclaim.reclaim()).toEqual({ queues: 1, jobs: 0 });
        await adder.query('COMMIT');
      } finally {
        adder.release();
      }
      expect(await queueNames()).toEqual([]);
      const [stranded] = await jobQueueIds();
      expect(stranded.job_queue_id).not.toBeNull();
      expect(stranded.queue_name).toBeNull();

      // The next reclaim after a removal repairs.
      expect(await reclaim.reclaim()).toEqual({ queues: 0, jobs: 1 });
      expect(await jobQueueIds()).toEqual([
        {
          task_identifier: 'workflow_flows_executor',
          queue_name: null,
          job_queue_id: null,
        },
      ]);
      // Graphile Worker now runs it.
      const ran = Promise.withResolvers<void>();
      const runner = await run({
        pgPool: pool,
        concurrency: 1,
        pollInterval: 50,
        noHandleSignals: true,
        taskList: {
          workflow_flows_executor: async () => ran.resolve(),
        },
      });
      try {
        await ran.promise;
      } finally {
        await runner.stop();
      }
    }, 30_000);

    it('repairs on its first reclaim and on the ones after a removal, not on every one', async () => {
      // A job naming a queue that no longer exists.
      const strand = async () => {
        const job = await utils.addJob('workflow_flows', {});
        await pool.query(
          'UPDATE graphile_worker._private_jobs SET job_queue_id = -1 WHERE id = $1',
          [job.id]
        );
      };
      const reclaim = reclaimer();
      await strand();
      // The first reclaim repairs, for a process that exited before its
      // own repairs ran.
      expect(await reclaim.reclaim()).toEqual({ queues: 0, jobs: 1 });
      await strand();
      // Nothing was removed, so the next one does not read every job.
      expect(await reclaim.reclaim()).toEqual({ queues: 0, jobs: 0 });
      // A removal: that reclaim repairs (the job left above), and so do the
      // next ones.
      await emptyQueue('workflow_flows:wrun_01AFTER');
      expect(await reclaim.reclaim()).toEqual({ queues: 1, jobs: 1 });
      for (let i = 0; i < REPAIRS_AFTER_REMOVAL; i++) {
        await strand();
        expect(await reclaim.reclaim()).toEqual({ queues: 0, jobs: 1 });
      }
      await strand();
      expect(await reclaim.reclaim()).toEqual({ queues: 0, jobs: 0 });
    });

    it("leaves another application's jobs alone, even when their queue is gone", async () => {
      await utils.addJob('billing_task', {}, { queueName: 'billing:queue' });
      await pool.query(
        `DELETE FROM graphile_worker._private_job_queues WHERE queue_name = 'billing:queue'`
      );
      expect(await reclaimer().reclaim()).toEqual({ queues: 0, jobs: 0 });
      const [job] = await jobQueueIds();
      expect(job.job_queue_id).not.toBeNull();
    });
  }
);
