import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import type { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { createRunQueueReaper } from '../src/run-queue-reaper.js';
import { TestPool } from './pool.js';

const ADD_JOB = `SELECT id FROM graphile_worker.add_job(
  identifier => $1, payload => '{}'::json, queue_name => $2
)`;

describe.skipIf(process.platform === 'win32')(
  'reclaiming per-run Graphile queues (real database)',
  () => {
    const TASK = 'workflow_flows';
    const PREFIX = `${TASK}:`;
    const SUFFIX = ':executor';
    const queueName = (runId: string) => `${PREFIX}${runId}${SUFFIX}`;
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: Pool;
    let utils: WorkerUtils;

    const reaper = () =>
      createRunQueueReaper(pool, {
        prefix: PREFIX,
        suffix: SUFFIX,
        settledSeconds: 60,
      });

    /** Leave the run's queue behind holding no job, as a finished run does. */
    async function emptyQueueFor(runId: string) {
      const { rows } = await pool.query<{ id: string }>(ADD_JOB, [
        TASK,
        queueName(runId),
      ]);
      await utils.completeJobs([rows[0].id]);
    }

    async function queueNames(): Promise<string[]> {
      const { rows } = await pool.query<{ queue_name: string }>(
        'SELECT queue_name FROM graphile_worker._private_job_queues ORDER BY queue_name'
      );
      return rows.map((row) => row.queue_name);
    }

    /** Jobs whose queue is gone, which no worker can claim again. */
    async function orphanedJobs(): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graphile_worker._private_jobs AS jobs
          WHERE jobs.job_queue_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM graphile_worker._private_job_queues AS job_queues
              WHERE job_queues.id = jobs.job_queue_id
            )`
      );
      return Number(rows[0].count);
    }

    /** Jobs a worker would admit, by `getJob`'s own predicate. */
    async function claimableJobs(): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graphile_worker._private_jobs AS jobs
          WHERE jobs.is_available = true
            AND (
              jobs.job_queue_id IS NULL
              OR jobs.job_queue_id IN (
                SELECT id FROM graphile_worker._private_job_queues
                WHERE is_available = true
              )
            )`
      );
      return Number(rows[0].count);
    }

    async function insertRun(
      runId: string,
      status: string,
      completedAt: Date | null
    ) {
      await pool.query(
        `INSERT INTO workflow.workflow_runs
           (id, deployment_id, status, name, completed_at)
         VALUES ($1, 'test', $2, 'test-workflow', $3)`,
        [runId, status, completedAt]
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      const dbUrl = container.getConnectionUri();
      process.env.DATABASE_URL = dbUrl;
      process.env.WORKFLOW_POSTGRES_URL = dbUrl;
      execSync('pnpm db:push', {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      });
      pool = new TestPool({ connectionString: dbUrl, max: 10 });
      utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
    }, 180_000);

    afterAll(async () => {
      await utils?.release();
      await pool?.end();
      await container?.stop();
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM graphile_worker._private_jobs');
      await pool.query('DELETE FROM graphile_worker._private_job_queues');
      await pool.query('TRUNCATE TABLE workflow.workflow_runs CASCADE');
    });

    test('reclaims the queues of gone and settled runs only', async () => {
      const settled = new Date(Date.now() - 3_600_000);
      await insertRun('wrun_settled', 'completed', settled);
      await insertRun('wrun_just_finished', 'completed', new Date());
      await insertRun('wrun_running', 'running', null);
      await insertRun('wrun_busy', 'failed', settled);
      for (const runId of [
        'wrun_settled',
        'wrun_just_finished',
        'wrun_running',
        'wrun_gone',
      ]) {
        await emptyQueueFor(runId);
      }
      await pool.query(ADD_JOB, [TASK, queueName('wrun_busy')]);
      await pool.query(ADD_JOB, ['other_app', 'other_app_queue']);

      const reclaimed = await reaper().sweepOnce();

      expect([...reclaimed].sort()).toEqual([
        queueName('wrun_gone'),
        queueName('wrun_settled'),
      ]);
      expect(await queueNames()).toEqual([
        'other_app_queue',
        queueName('wrun_busy'),
        queueName('wrun_just_finished'),
        queueName('wrun_running'),
      ]);
      expect(await orphanedJobs()).toBe(0);
    });

    test('leaves the queue of a send in flight, and loses no job', async () => {
      await emptyQueueFor('wrun_race');
      const sender = await pool.connect();
      try {
        await sender.query('BEGIN');
        // Past `add_job`'s read of the queue id and not yet committed: the
        // state in which an unfenced reclaim strands this job.
        await sender.query(ADD_JOB, [TASK, queueName('wrun_race')]);

        const sweeping = reaper()
          .sweepOnce()
          .catch(() => []);
        await sleep(100);
        await sender.query('COMMIT');
        expect(await sweeping).toEqual([]);
      } finally {
        sender.release();
      }

      expect(await queueNames()).toEqual([queueName('wrun_race')]);
      expect(await orphanedJobs()).toBe(0);
      expect(await claimableJobs()).toBe(1);
    });

    test('keeps every job claimable while sends and sweeps race', async () => {
      const runIds = Array.from({ length: 12 }, (_, index) => `wrun_r${index}`);
      const sweeper = reaper();

      await Promise.all(
        runIds.map(async (runId) => {
          await emptyQueueFor(runId);
          await Promise.all([
            sweeper.sweepOnce().catch(() => []),
            pool.query(ADD_JOB, [TASK, queueName(runId)]),
          ]);
        })
      );

      expect(await orphanedJobs()).toBe(0);
      expect(await claimableJobs()).toBe(runIds.length);
    });
  }
);
