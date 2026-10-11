import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { getQueueTopicPrefix } from '@workflow/world';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createQueue } from '../src/queue.js';

/**
 * pauseClaims()/resumeClaims() against a real Graphile Worker: a paused
 * queue claims nothing (its own enqueues included) until resumed, and a job
 * already running when the pause lands finishes and is recorded, with
 * close() waiting for it.
 */
describe('Postgres queue claims (integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let connectionString: string;
  let server: Server;
  let delivered: string[] = [];
  let holdNext: Promise<void> | null = null;

  const queueName = `${getQueueTopicPrefix('workflow')}test` as const;
  const jobsLeft = async () =>
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM graphile_worker._private_jobs'
      )
    ).rows[0].count as number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    connectionString = container.getConnectionUri();
    pool = new Pool({ connectionString, max: 4 });
    server = createServer(async (request, response) => {
      const body = JSON.parse(
        Buffer.concat(await request.toArray()).toString()
      );
      delivered.push(body.runId);
      const held = holdNext;
      holdNext = null;
      if (held) await held;
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

  test('a paused queue claims nothing, its own enqueue included, until resumed', async () => {
    delivered = [];
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 2,
        applicationManagedShutdown: true,
      },
      pool
    );
    try {
      await queue.pauseClaims();
      await queue.start();
      const runId = `run_${randomUUID()}`;
      await queue.queue(queueName, { runId });

      // Longer than Graphile Worker's 500ms poll interval.
      await sleep(1_500);
      expect(delivered).toEqual([]);
      expect(await jobsLeft()).toBe(1);

      await queue.resumeClaims();
      await expect.poll(jobsLeft, { timeout: 5_000 }).toBe(0);
      expect(delivered).toEqual([runId]);
    } finally {
      await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  });

  test('a job running when claims pause finishes, and close() waits for it', async () => {
    delivered = [];
    const release = Promise.withResolvers<void>();
    holdNext = release.promise;
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 2,
        applicationManagedShutdown: true,
      },
      pool
    );
    let closed = false;
    try {
      const inFlight = `run_${randomUUID()}`;
      await queue.queue(queueName, { runId: inFlight });
      await expect
        .poll(() => delivered, { timeout: 5_000 })
        .toEqual([inFlight]);

      // Resolves while that delivery is still open.
      await queue.pauseClaims();
      const afterPause = `run_${randomUUID()}`;
      await queue.queue(queueName, { runId: afterPause });
      await sleep(1_500);
      expect(delivered).toEqual([inFlight]);

      const closing = queue.close().then(() => {
        closed = true;
      });
      await sleep(250);
      expect(closed).toBe(false);

      release.resolve();
      await closing;
      // The in-flight job completed (its row is gone); the one enqueued after
      // the pause is still waiting for a queue that claims.
      expect(delivered).toEqual([inFlight]);
      expect(await jobsLeft()).toBe(1);
    } finally {
      release.resolve();
      if (!closed) await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  });
});
