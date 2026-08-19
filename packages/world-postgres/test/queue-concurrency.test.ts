import { createServer, type Server } from 'node:http';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest';
import { createQueue } from '../src/queue.js';

describe('Postgres queue concurrency', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
  let connectionString: string;
  let observerPool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    connectionString = container.getConnectionUri();
    observerPool = new Pool({ connectionString });
  }, 120_000);

  afterAll(async () => {
    await observerPool?.end();
    await container?.stop();
  });

  it('serializes the same keyed delivery across independent workers', async () => {
    const firstPool = new Pool({ connectionString });
    const secondPool = new Pool({ connectionString });
    const firstQueue = createQueue(
      {
        pool: firstPool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      },
      firstPool
    );
    const secondQueue = createQueue(
      {
        pool: secondPool,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      },
      secondPool
    );
    const firstRequestStarted = deferred<void>();
    const releaseRequests = deferred<void>();
    let requestCount = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const server = await startWorkflowServer(async () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      firstRequestStarted.resolve();
      await releaseRequests.promise;
      activeRequests -= 1;
    });
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queueName = '__wkf_workflow_slow-provider-call';
    const idempotencyKey = 'step_eng570_same_call';
    const payload = {
      runId: 'wrun_eng570',
      stepId: idempotencyKey,
      stepName: 'slow-provider-call',
    };

    try {
      await firstQueue.start();
      await secondQueue.start();
      await firstQueue.queue(queueName, payload, { idempotencyKey });
      await firstRequestStarted.promise;

      await secondQueue.queue(queueName, payload, { idempotencyKey });

      await waitForJobs(2);
      // Give both pollers longer than their 500 ms polling interval to claim
      // the successor if the database queue is not enforcing serialization.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const rows = await getJobs();
      expect(requestCount).toBe(1);
      expect(maxActiveRequests).toBe(1);
      expect(rows).toEqual([
        expect.objectContaining({
          key: null,
          locked_by: expect.any(String),
          queue_name: expect.stringMatching(
            /^workflow_idempotency_[0-9a-f]{64}_[0-9a-f]{3}$/
          ),
        }),
        expect.objectContaining({
          key: idempotencyKey,
          locked_by: null,
          queue_name: expect.stringMatching(
            /^workflow_idempotency_[0-9a-f]{64}_[0-9a-f]{3}$/
          ),
        }),
      ]);
      expect(new Set(rows.map((row) => row.queue_name))).toHaveLength(1);

      releaseRequests.resolve();
      await vi.waitFor(
        async () => {
          expect(await countJobs()).toBe(0);
        },
        { interval: 25, timeout: 5_000 }
      );

      expect(requestCount).toBeGreaterThanOrEqual(1);
      expect(requestCount).toBeLessThanOrEqual(2);
      expect(maxActiveRequests).toBe(1);
    } finally {
      releaseRequests.resolve();
      delete process.env.WORKFLOW_LOCAL_BASE_URL;
      await Promise.allSettled([firstQueue.close(), secondQueue.close()]);
      await Promise.allSettled([firstPool.end(), secondPool.end()]);
      await closeServer(server.instance);
    }
  }, 30_000);

  async function waitForJobs(count: number) {
    await vi.waitFor(async () => {
      expect(await getJobs()).toHaveLength(count);
    });
  }

  async function getJobs() {
    const result = await observerPool.query<{
      key: string | null;
      locked_by: string | null;
      queue_name: string | null;
    }>(
      `SELECT key, locked_by, queue_name
      FROM graphile_worker.jobs
      WHERE task_identifier = 'workflow_flows'
      ORDER BY id`
    );
    return result.rows;
  }

  async function countJobs() {
    const result = await observerPool.query<{ count: string }>(
      `SELECT count(*)
      FROM graphile_worker.jobs
      WHERE task_identifier = 'workflow_flows'`
    );
    return Number(result.rows[0]?.count ?? 0);
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startWorkflowServer(handler: () => Promise<void>) {
  const instance = createServer(async (request, response) => {
    request.resume();
    await handler();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', resolve);
  });
  const address = instance.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an HTTP server port');
  }
  return { instance, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
