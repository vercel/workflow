import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { getQueueTopicPrefix } from '@workflow/world';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { LostWorker } from '../src/config.js';
import { createQueue } from '../src/queue.js';

type Delivery = {
  runId: string;
  attempt: string | string[] | undefined;
  /** Whether the queue gave up on the request before it was answered. */
  aborted: boolean;
};

/**
 * Graphile Worker 0.16 ends a worker whose job release fails with an error it
 * does not retry, and never replaces it. These tests run a real Graphile
 * Worker against Postgres, where a trigger refuses one job's completion
 * (SQLSTATE P0001, which Graphile Worker does not retry, as it does not retry
 * a dropped or refused connection), and a loopback handler that answers every
 * delivery, holding some until the test lets them finish.
 */
describe('Postgres queue lost workers (integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  const topic = `${getQueueTopicPrefix('workflow')}test`;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let connectionString: string;
  let server: Server;
  let deliveries: Delivery[] = [];
  /** Deliveries of these runs are answered once their promise settles. */
  const holds = new Map<string, Promise<void>>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    connectionString = container.getConnectionUri();
    pool = new Pool({ connectionString, max: 4 });
    server = createServer(async (request, response) => {
      const body = Buffer.concat(await request.toArray()).toString();
      const delivery: Delivery = {
        runId: String(JSON.parse(body).runId),
        attempt: request.headers['x-vqs-message-attempt'],
        aborted: false,
      };
      deliveries.push(delivery);
      response.on('close', () => {
        if (!response.writableFinished) delivery.aborted = true;
      });
      await holds.get(delivery.runId);
      if (!response.destroyed) response.end('{}');
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
    deliveries = [];
    holds.clear();
    await pool.query(`
      DROP TRIGGER IF EXISTS refuse_release ON graphile_worker._private_jobs;
      DROP FUNCTION IF EXISTS refuse_release();
      TRUNCATE graphile_worker._private_jobs;
    `);
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

  /** Make Graphile Worker's release of the job keyed `release-refused` fail. */
  async function refuseRelease() {
    await pool.query(`
      CREATE FUNCTION refuse_release() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.key = 'release-refused' THEN
          RAISE EXCEPTION 'release refused';
        END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER refuse_release BEFORE DELETE ON graphile_worker._private_jobs
        FOR EACH ROW EXECUTE FUNCTION refuse_release();
    `);
  }

  /**
   * The backends of the runners listening for new jobs. A runner keeps one
   * until it stops, which runs UNLISTEN on it and hands it back to the pool.
   */
  async function listeners() {
    const backends = await pool.query(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN "jobs:insert"%'`
    );
    return backends.rows.map(({ pid }) => pid as number);
  }

  async function jobCount(key: string) {
    const jobs = await pool.query(
      'SELECT count(*)::int AS count FROM graphile_worker._private_jobs WHERE key = $1',
      [key]
    );
    return jobs.rows[0].count as number;
  }

  function startQueue(queueConcurrency: number, lost: LostWorker[]) {
    return createQueue(
      {
        connectionString,
        queueConcurrency,
        applicationManagedShutdown: true,
        onWorkerLost: (worker) => lost.push(worker),
      },
      pool
    );
  }

  test('a queue keeps claiming after Graphile Worker ends its only worker over a failed release', async () => {
    const lost: LostWorker[] = [];
    const queue = startQueue(1, lost);
    try {
      await queue.start();
      await refuseRelease();

      await queue.queue(
        topic,
        { runId: 'run_release_refused' },
        { idempotencyKey: 'release-refused' }
      );
      await expect.poll(() => lost.length, { timeout: 10_000 }).toBe(1);
      const refused = await pool.query(
        `SELECT id::text AS id, locked_at FROM graphile_worker._private_jobs WHERE key = 'release-refused'`
      );
      expect(lost[0]).toMatchObject({
        jobId: refused.rows[0].id,
        error: expect.objectContaining({ code: 'P0001' }),
      });
      // Locked until Graphile Worker's reset of jobs locked for over 4 hours.
      expect(refused.rows[0].locked_at).not.toBeNull();

      const { messageId } = await queue.queue(topic, {
        runId: 'run_after_loss',
      });
      await expect.poll(() => jobCount(messageId), { timeout: 10_000 }).toBe(0);
      expect(deliveries.map(({ runId }) => runId)).toEqual([
        'run_release_refused',
        'run_after_loss',
      ]);
    } finally {
      await queue.close();
    }
  });

  test("a delivery still running on the replaced runner finishes past Graphile Worker's shutdown abort", async () => {
    // Stopping the replaced runner arms Graphile Worker's abort of its jobs'
    // signals, 5s later. Aborted, this delivery would lose its attempt and be
    // delivered again while its handler might still be running.
    const lost: LostWorker[] = [];
    const held = Promise.withResolvers<void>();
    holds.set('run_held', held.promise);
    const queue = startQueue(2, lost);
    try {
      await queue.start();
      await refuseRelease();
      await expect.poll(listeners, { timeout: 10_000 }).toHaveLength(1);
      const [replaced] = await listeners();
      const { messageId } = await queue.queue(topic, { runId: 'run_held' });
      await expect
        .poll(() => deliveries.map(({ runId }) => runId), { timeout: 10_000 })
        .toEqual(['run_held']);

      await queue.queue(
        topic,
        { runId: 'run_release_refused' },
        { idempotencyKey: 'release-refused' }
      );
      await expect.poll(() => lost.length, { timeout: 10_000 }).toBe(1);
      // The replacement listens, and the replaced runner has stopped.
      await expect
        .poll(
          async () => {
            const pids = await listeners();
            return pids.length === 1 && pids[0] !== replaced;
          },
          { timeout: 10_000 }
        )
        .toBe(true);
      // Past the 5s after which Graphile Worker aborts a stopping runner's
      // job signals.
      await sleep(6_000);
      held.resolve();

      await expect.poll(() => jobCount(messageId), { timeout: 10_000 }).toBe(0);
      expect(deliveries).toEqual([
        { runId: 'run_held', attempt: '1', aborted: false },
        { runId: 'run_release_refused', attempt: '1', aborted: false },
      ]);
    } finally {
      held.resolve();
      await queue.close();
    }
  }, 30_000);
});
