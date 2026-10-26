import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  getQueueTopicPrefix,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createQueue } from '../src/queue.js';
import { TestPool } from './pool.js';

/**
 * Queue deliveries execute the workflow body inline, so response headers
 * arrive only once that work is done. These tests run a real Graphile Worker
 * against a loopback handler that answers slowly, with the process-global
 * `fetch` dispatcher pinned to a 10ms deadline: a delivery that still went
 * through `fetch` would be declared failed and redelivered (attempt 2), which
 * is the production failure mode at undici's default 300s.
 */
describe('Postgres queue HTTP deadlines (integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  const originalDispatcher = getGlobalDispatcher();
  const shortDeadline = new Agent({ headersTimeout: 10, bodyTimeout: 10 });
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let connectionString: string;
  let server: Server;
  let phase:
    | 'headers'
    | 'body'
    | 'abort'
    | 'hook'
    | 'serial'
    | 'reschedule'
    | 'reject-then-handoff';
  let serialStarts: string[] = [];
  let releaseInlineStep = Promise.withResolvers<void>();
  let accepted = Promise.withResolvers<void>();
  let disconnected = Promise.withResolvers<void>();
  let attempts: string[] = [];
  let deliveryCounts: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    connectionString = container.getConnectionUri();
    pool = new TestPool({ connectionString, max: 4 });
    server = createServer(async (request, response) => {
      const body = (await request.toArray()) as Buffer[];
      attempts.push(String(request.headers['x-vqs-message-attempt']));
      deliveryCounts.push(
        String(request.headers['x-vqs-message-delivery-count'])
      );
      response.on('close', () => disconnected.resolve());
      accepted.resolve();
      if (phase === 'abort') return;
      if (phase === 'reschedule') {
        // Ask for the same message again twice, then acknowledge it.
        response.end(
          attempts.length < 3 ? JSON.stringify({ timeoutSeconds: 0 }) : '{}'
        );
        return;
      }
      if (phase === 'reject-then-handoff') {
        // Reject the first delivery, hand the redelivery off, then
        // acknowledge.
        if (attempts.length === 1) {
          response.statusCode = 500;
          response.end('rejected');
        } else {
          response.end(
            attempts.length === 2 ? JSON.stringify({ timeoutSeconds: 0 }) : '{}'
          );
        }
        return;
      }
      if (phase === 'hook') {
        if (attempts.length === 1) await releaseInlineStep.promise;
        else releaseInlineStep.resolve();
        response.end('{}');
        return;
      }
      if (phase === 'serial') {
        const { stepId } = JSON.parse(Buffer.concat(body).toString()) as {
          stepId?: string;
        };
        serialStarts.push(stepId ?? 'orchestrator');
        // The first orchestrator delivery holds until the test releases it,
        // as one running an inline step would.
        if (serialStarts.length === 1) await releaseInlineStep.promise;
        response.end('{}');
        return;
      }
      if (phase === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
      }
      await sleep(1_500);
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
    setGlobalDispatcher(shortDeadline);
  }, 120_000);

  afterAll(async () => {
    setGlobalDispatcher(originalDispatcher);
    await shortDeadline.close();
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

  test.each([
    'headers',
    'body',
  ] as const)('a healthy delivery outlives the global fetch %s deadline', async (delayedPhase) => {
    phase = delayedPhase;
    attempts = [];
    accepted = Promise.withResolvers<void>();
    disconnected = Promise.withResolvers<void>();
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      },
      pool
    );
    try {
      const { messageId } = await queue.queue(
        `${getQueueTopicPrefix('workflow')}test`,
        { runId: `run_${randomUUID()}` }
      );
      await accepted.promise;
      await expect
        .poll(
          async () => {
            const jobs = await pool.query(
              'SELECT count(*)::int AS count FROM graphile_worker._private_jobs WHERE key = $1',
              [messageId]
            );
            return jobs.rows[0].count;
          },
          { timeout: 2_500 }
        )
        .toBe(0);
      expect(attempts).toEqual(['1']);
    } finally {
      await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  });

  // `{ timeoutSeconds: 0 }` on a spec 9 run is a handoff: redelivered at
  // once, and not counted as an attempt.
  test('a { timeoutSeconds: 0 } handoff reports the next delivery count and leaves attempt alone', async () => {
    phase = 'reschedule';
    attempts = [];
    deliveryCounts = [];
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      },
      pool
    );
    try {
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: `run_${randomUUID()}`,
        runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      });
      // `deliveryCount` keeps counting the message's deliveries; a handoff
      // is not an attempt, so `attempt` stays where it was.
      await expect.poll(() => attempts, { timeout: 10_000 }).toHaveLength(3);
      expect(deliveryCounts).toEqual(['1', '2', '3']);
      expect(attempts).toEqual(['1', '1', '1']);
    } finally {
      await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  });

  // A crash or a rejected delivery counts as an attempt, and a handoff that
  // follows it must not hide that from the next delivery: core reads a
  // redelivery from `attempt`.
  test('a { timeoutSeconds: 0 } handoff after a rejected delivery keeps its attempt', async () => {
    phase = 'reject-then-handoff';
    attempts = [];
    deliveryCounts = [];
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      },
      pool
    );
    try {
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
        runId: `run_${randomUUID()}`,
        runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      });
      await expect.poll(() => attempts, { timeout: 30_000 }).toHaveLength(3);
      expect(deliveryCounts).toEqual(['1', '2', '3']);
      expect(attempts).toEqual(['1', '2', '2']);
    } finally {
      await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  }, 60_000);

  test('a same-run wake of a spec 8 run can release an inline step before its delivery finishes', async () => {
    phase = 'hook';
    attempts = [];
    accepted = Promise.withResolvers<void>();
    releaseInlineStep = Promise.withResolvers<void>();
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 2,
        applicationManagedShutdown: true,
      },
      pool
    );
    const payload = { runId: `run_${randomUUID()}` };
    try {
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, payload);
      await accepted.promise;
      // Legacy hook producers send a wake without an idempotency key.
      // The handler holding the first delivery needs this wake to finish.
      await queue.queue(`${getQueueTopicPrefix('workflow')}test`, payload);
      await expect.poll(() => attempts.length, { timeout: 2_500 }).toBe(2);
      await expect
        .poll(
          async () => {
            const jobs = await pool.query(
              'SELECT count(*)::int AS count FROM graphile_worker._private_jobs'
            );
            return jobs.rows[0].count;
          },
          { timeout: 2_500 }
        )
        .toBe(0);
      expect(attempts).toEqual(['1', '1']);
    } finally {
      releaseInlineStep.resolve();
      await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  });

  test('a same-run wake of a spec 9 run waits for the in-flight orchestrator delivery while its steps run', async () => {
    phase = 'serial';
    attempts = [];
    serialStarts = [];
    accepted = Promise.withResolvers<void>();
    releaseInlineStep = Promise.withResolvers<void>();
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 4,
        pollInterval: 50,
        applicationManagedShutdown: true,
      },
      pool
    );
    const runId = `run_${randomUUID()}`;
    const topic = `${getQueueTopicPrefix('workflow')}test` as const;
    try {
      const runSpecVersion = SPEC_VERSION_SINGLE_ORCHESTRATOR;
      await queue.queue(topic, { runId, runSpecVersion });
      await accepted.promise;
      // A wake (no idempotency key) and a step message for the same run,
      // while the first delivery is still running.
      await queue.queue(topic, { runId, runSpecVersion });
      await queue.queue(topic, {
        runId,
        stepId: 'step_1',
        stepName: 'add',
        runSpecVersion,
      });
      // The step message runs; the wake does not, with free worker slots.
      await expect
        .poll(() => serialStarts, { timeout: 2_500 })
        .toEqual(['orchestrator', 'step_1']);
      await sleep(500);
      expect(serialStarts).toEqual(['orchestrator', 'step_1']);

      releaseInlineStep.resolve();
      await expect
        .poll(() => serialStarts, { timeout: 2_500 })
        .toEqual(['orchestrator', 'step_1', 'orchestrator']);
      await expect
        .poll(
          async () => {
            const jobs = await pool.query(
              'SELECT count(*)::int AS count FROM graphile_worker._private_jobs'
            );
            return jobs.rows[0].count;
          },
          { timeout: 2_500 }
        )
        .toBe(0);
    } finally {
      releaseInlineStep.resolve();
      await queue.close();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    }
  });

  test('shutdown still aborts a pending delivery and releases its job', async () => {
    phase = 'abort';
    accepted = Promise.withResolvers<void>();
    disconnected = Promise.withResolvers<void>();
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
      },
      pool
    );
    await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
      runId: `run_${randomUUID()}`,
    });
    await accepted.promise;
    await queue.close();
    await disconnected.promise;
    const jobs = await pool.query(
      'SELECT attempts, locked_at FROM graphile_worker._private_jobs'
    );
    expect(jobs.rows).toEqual([{ attempts: 1, locked_at: null }]);
  });
});
