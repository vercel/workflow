import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRunLeases, type LeftJob } from '../src/run-lease.js';
import { TestPool } from './pool.js';

/**
 * Per-run delivery leases (`run-lease.ts`) against a real Postgres and
 * Graphile Worker schema. Graphile jobs are added and locked by hand, so each
 * test sets up exactly the owner state it needs.
 */
describe.skipIf(process.platform === 'win32')(
  'run delivery leases (real database)',
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
      await pool.query('CREATE SCHEMA IF NOT EXISTS workflow');
      await pool.query(
        await readFile(
          new URL(
            '../src/drizzle/migrations/0031_add_run_delivery_leases.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
    }, 120_000);

    afterEach(async () => {
      await pool.query(
        'TRUNCATE graphile_worker._private_jobs, workflow.workflow_run_delivery_leases'
      );
    });

    afterAll(async () => {
      await utils?.release();
      await pool?.end();
      await container?.stop();
    });

    /** A Graphile job, optionally locked as a running delivery holds it. */
    async function job(
      opts: { locked?: boolean; attempts?: number; maxAttempts?: number } = {}
    ) {
      const added = await utils.addJob(
        'lease_test',
        { n: Math.random() },
        { maxAttempts: opts.maxAttempts ?? 25 }
      );
      await pool.query(
        `UPDATE graphile_worker._private_jobs
            SET locked_at = CASE WHEN $2 THEN now() END,
                locked_by = CASE WHEN $2 THEN 'worker' END,
                attempts = $3
          WHERE id = $1`,
        [added.id, opts.locked ?? true, opts.attempts ?? 1]
      );
      return String(added.id);
    }

    const left = (marker: string): LeftJob => ({
      task: 'lease_test',
      payload: { marker },
      jobKey: `left:${marker}`,
      maxAttempts: 7,
    });

    async function row(runId: string) {
      const { rows } = await pool.query(
        'SELECT owner_job_id::text AS owner, wake, wake_resume, deferred FROM workflow.workflow_run_delivery_leases WHERE run_id = $1',
        [runId]
      );
      return rows[0];
    }

    async function jobsByKey(key: string) {
      const { rows } = await pool.query(
        'SELECT tasks.identifier AS task_identifier, jobs.payload, jobs.max_attempts FROM graphile_worker._private_jobs AS jobs JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id WHERE jobs.key = $1',
        [key]
      );
      return rows;
    }

    it('gives the lease to one delivery and leaves the others’ messages for it', async () => {
      const leases = createRunLeases(pool);
      const owner = await job();
      const second = await job();
      const third = await job();
      const fourth = await job();

      await expect(
        leases.claim('run_a', owner, left('own'), 'wake', false)
      ).resolves.toEqual({ owner: true });
      await expect(
        leases.claim('run_a', second, left('plain'), 'wake', false)
      ).resolves.toEqual({ owner: false });
      // A wake with a resume's timing replaces a plain one, and later plain
      // wakes do not replace it.
      await expect(
        leases.claim('run_a', third, left('resume'), 'wake', true)
      ).resolves.toEqual({ owner: false });
      await leases.claim('run_a', fourth, left('later'), 'wake', false);
      // A message no re-run covers is kept, in order.
      await leases.claim('run_a', second, left('start'), 'deferred', false);
      await leases.claim('run_a', third, left('hook'), 'deferred', false);

      expect(await row('run_a')).toEqual({
        owner,
        wake: left('resume'),
        wake_resume: true,
        deferred: [left('start'), left('hook')],
      });
      // The owner's re-run takes the wake; the deferred ones stay.
      await expect(leases.takeWake('run_a', owner)).resolves.toEqual(
        left('resume')
      );
      await expect(leases.takeWake('run_a', owner)).resolves.toBeUndefined();
      // Only the owner takes it.
      await leases.claim('run_a', second, left('plain'), 'wake', false);
      await expect(leases.takeWake('run_a', second)).resolves.toBeUndefined();
      expect((await row('run_a')).wake).toEqual(left('plain'));
    });

    it('re-adds what was left on the lease as jobs when it is released, and frees it', async () => {
      const leases = createRunLeases(pool);
      const owner = await job();
      const other = await job();
      await leases.claim('run_b', owner, left('own'), 'wake', false);
      await leases.claim('run_b', other, left('wake'), 'wake', false);
      await leases.claim('run_b', other, left('start'), 'deferred', false);

      await leases.release('run_b', owner);

      expect(await row('run_b')).toBeUndefined();
      for (const marker of ['wake', 'start']) {
        expect(await jobsByKey(`left:${marker}`)).toEqual([
          {
            task_identifier: 'lease_test',
            payload: { marker },
            max_attempts: 7,
          },
        ]);
      }
      // Free: the next delivery takes it.
      await expect(
        leases.claim('run_b', other, left('next'), 'wake', false)
      ).resolves.toEqual({ owner: true });
    });

    it('releases a lease with nothing left on it without re-adding anything', async () => {
      const leases = createRunLeases(pool);
      const owner = await job();
      await leases.claim('run_c', owner, left('own'), 'wake', false);
      await leases.release('run_c', owner);
      expect(await row('run_c')).toBeUndefined();
      expect(await jobsByKey('left:own')).toEqual([]);
      // Releasing a lease this job does not own changes nothing.
      const other = await job();
      await leases.claim('run_c', other, left('own'), 'wake', false);
      await leases.release('run_c', owner);
      expect((await row('run_c')).owner).toBe(other);
    });

    it('gives a crashed holder’s redelivery, the same job, its lease back', async () => {
      const leases = createRunLeases(pool);
      const owner = await job();
      const other = await job();
      await leases.claim('run_d', owner, left('own'), 'wake', false);
      await leases.claim('run_d', other, left('wake'), 'wake', false);
      // The holder died and its lock was released: the job waits to be
      // redelivered, with attempts left, so it still owns the lease.
      await pool.query(
        'UPDATE graphile_worker._private_jobs SET locked_at = NULL, locked_by = NULL WHERE id = $1',
        [owner]
      );
      await expect(
        leases.claim('run_d', other, left('again'), 'wake', false)
      ).resolves.toEqual({ owner: false });
      await expect(
        leases.claim('run_d', owner, left('own'), 'wake', false)
      ).resolves.toEqual({ owner: true });
      // With what was left for it.
      expect((await row('run_d')).wake).toEqual(left('wake'));
    });

    it('lets the next delivery take over a lease whose owner can no longer run, keeping what was left on it', async () => {
      const leases = createRunLeases(pool);
      const completed = await job();
      const exhausted = await job({ attempts: 3, maxAttempts: 3 });
      const other = await job();
      await leases.claim('run_e', completed, left('own'), 'wake', false);
      await leases.claim('run_e', other, left('start'), 'deferred', false);
      // Its job finished without releasing (a failed release, say).
      await pool.query(
        'DELETE FROM graphile_worker._private_jobs WHERE id = $1',
        [completed]
      );
      await expect(
        leases.claim('run_e', other, left('own'), 'wake', false)
      ).resolves.toEqual({ owner: true });
      expect(await row('run_e')).toMatchObject({
        owner: other,
        deferred: [left('start')],
      });

      // A job that used its last attempt and is no longer locked will
      // never run again.
      await leases.claim('run_f', exhausted, left('own'), 'wake', false);
      await pool.query(
        'UPDATE graphile_worker._private_jobs SET locked_at = NULL, locked_by = NULL WHERE id = $1',
        [exhausted]
      );
      await expect(
        leases.claim('run_f', other, left('own'), 'wake', false)
      ).resolves.toEqual({ owner: true });
    });

    it('keeps a running delivery on its last attempt as the owner', async () => {
      const leases = createRunLeases(pool);
      const last = await job({ attempts: 3, maxAttempts: 3 });
      const other = await job();
      await leases.claim('run_g', last, left('own'), 'wake', false);
      await expect(
        leases.claim('run_g', other, left('wake'), 'wake', false)
      ).resolves.toEqual({ owner: false });
    });

    it('hands the lease to a handoff’s continuation, which takes it while it waits to start', async () => {
      const leases = createRunLeases(pool);
      const owner = await job();
      const continuation = await job({ locked: false, attempts: 0 });
      const other = await job();
      await leases.claim('run_h', owner, left('own'), 'wake', false);
      await expect(leases.transfer('run_h', owner, continuation)).resolves.toBe(
        true
      );
      // The old owner can no longer hand it on.
      await expect(leases.transfer('run_h', owner, other)).resolves.toBe(false);
      await expect(
        leases.claim('run_h', other, left('wake'), 'wake', false)
      ).resolves.toEqual({ owner: false });
      await expect(
        leases.claim('run_h', continuation, left('own'), 'wake', false)
      ).resolves.toEqual({ owner: true });
      await expect(leases.takeWake('run_h', continuation)).resolves.toEqual(
        left('wake')
      );
    });

    it('serializes concurrent claims: exactly one delivery owns the lease', async () => {
      const leases = createRunLeases(pool);
      const jobs = await Promise.all(Array.from({ length: 8 }, () => job()));
      const results = await Promise.all(
        jobs.map((id) => leases.claim('run_i', id, left(id), 'wake', false))
      );
      expect(results.filter((result) => result.owner === true)).toHaveLength(1);
      expect(results.filter((result) => result.owner === false)).toHaveLength(
        7
      );
    });

    it('reports a missing table instead of failing the delivery', async () => {
      await pool.query(
        'ALTER TABLE workflow.workflow_run_delivery_leases RENAME TO leases_aside'
      );
      try {
        const leases = createRunLeases(pool);
        const owner = await job();
        await expect(
          leases.claim('run_j', owner, left('own'), 'wake', false)
        ).resolves.toEqual({ owner: undefined });
      } finally {
        await pool.query(
          'ALTER TABLE workflow.leases_aside RENAME TO workflow_run_delivery_leases'
        );
      }
    });
  }
);
