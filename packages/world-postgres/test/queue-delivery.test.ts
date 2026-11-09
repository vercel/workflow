import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  getQueueTopicPrefix,
  IN_PROCESS_QUEUE_HANDLER,
  type InProcessDelivery,
  type QueueRouteHandler,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createQueue } from '../src/queue.js';
import { TestPool } from './pool.js';

/**
 * Deliveries run the workflow body inline in the registered flow handler,
 * so a delivery responds only once that work is done. These tests run a real
 * Graphile Worker delivering to a handler registered in this process, as the
 * app registers its flow route when it starts, and check what the queue does
 * with the handler's answers: a handoff, a rejection, a wake of a run whose
 * delivery is in flight, a shutdown. The process-global `fetch` dispatcher
 * is pinned to a 10ms deadline throughout: a delivery that went through
 * `fetch` would be declared failed and redelivered.
 */
describe('Postgres queue in-process delivery (integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const topic = `${getQueueTopicPrefix('workflow')}test` as const;
  const originalDispatcher = getGlobalDispatcher();
  const shortDeadline = new Agent({ headersTimeout: 10, bodyTimeout: 10 });
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let connectionString: string;
  let phase:
    | 'slow'
    | 'abort'
    | 'hook'
    | 'serial'
    | 'reschedule'
    | 'reject-then-handoff';
  let serialStarts: string[] = [];
  let releaseInlineStep = Promise.withResolvers<void>();
  let accepted = Promise.withResolvers<void>();
  let attempts: string[] = [];
  let deliveryCounts: string[] = [];

  /** The app's flow handler for this test's phase: its in-process entry. */
  async function flowEntry({
    message,
    meta,
  }: InProcessDelivery): Promise<unknown> {
    attempts.push(String(meta.attempt));
    deliveryCounts.push(String(meta.deliveryCount));
    accepted.resolve();
    if (phase === 'abort') {
      // Holds the delivery for good, as a handler running a long inline
      // step does: shutdown releases the job, not the handler.
      await new Promise<never>(() => {});
    }
    if (phase === 'reschedule') {
      // Ask for the same message again twice, then acknowledge it.
      return attempts.length < 3 ? { timeoutSeconds: 0 } : undefined;
    }
    if (phase === 'reject-then-handoff') {
      // Reject the first delivery, hand the redelivery off, then
      // acknowledge.
      if (attempts.length === 1) throw new Error('rejected');
      return attempts.length === 2 ? { timeoutSeconds: 0 } : undefined;
    }
    if (phase === 'hook') {
      if (attempts.length === 1) await releaseInlineStep.promise;
      else releaseInlineStep.resolve();
      return undefined;
    }
    if (phase === 'serial') {
      const { stepId } = message as { stepId?: string };
      serialStarts.push(stepId ?? 'orchestrator');
      // The first orchestrator delivery holds until the test releases it,
      // as one running an inline step would.
      if (serialStarts.length === 1) await releaseInlineStep.promise;
      return undefined;
    }
    await sleep(1_500);
    return undefined;
  }
  const flowHandler: QueueRouteHandler = Object.assign(
    async () => Response.json({}),
    { [IN_PROCESS_QUEUE_HANDLER]: flowEntry }
  );

  /** A worker: a queue with the flow handler registered. */
  function createWorker(config: Partial<Parameters<typeof createQueue>[0]>) {
    const queue = createQueue(
      {
        connectionString,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
        ...config,
      } as Parameters<typeof createQueue>[0],
      pool
    );
    queue.registerHandler(getQueueTopicPrefix('workflow'), flowHandler);
    return queue;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    connectionString = container.getConnectionUri();
    pool = new TestPool({ connectionString, max: 4 });
    setGlobalDispatcher(shortDeadline);
  }, 120_000);

  afterAll(async () => {
    setGlobalDispatcher(originalDispatcher);
    await shortDeadline.close();
    await pool.end();
    await container.stop();
  });

  test('a slow delivery is not bound by the global fetch deadline', async () => {
    phase = 'slow';
    attempts = [];
    accepted = Promise.withResolvers<void>();
    const queue = createWorker({});
    try {
      const { messageId } = await queue.queue(topic, {
        runId: `run_${randomUUID()}`,
      });
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
    const queue = createWorker({});
    try {
      await queue.queue(topic, {
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
    const queue = createWorker({});
    try {
      await queue.queue(topic, {
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
    const queue = createWorker({ queueConcurrency: 2 });
    const payload = { runId: `run_${randomUUID()}` };
    try {
      await queue.queue(topic, payload);
      await accepted.promise;
      // Legacy hook producers send a wake without an idempotency key.
      // The handler holding the first delivery needs this wake to finish.
      await queue.queue(topic, payload);
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
    const queue = createWorker({ queueConcurrency: 4, pollInterval: 50 });
    const runId = `run_${randomUUID()}`;
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

  test('shutdown aborts a pending delivery and releases its job', async () => {
    phase = 'abort';
    accepted = Promise.withResolvers<void>();
    const queue = createWorker({});
    await queue.queue(topic, { runId: `run_${randomUUID()}` });
    await accepted.promise;
    // Shutdown abandons the delivery while the handler still runs.
    await queue.close();
    const jobs = await pool.query(
      'SELECT attempts, locked_at FROM graphile_worker._private_jobs'
    );
    expect(jobs.rows).toEqual([{ attempts: 1, locked_at: null }]);
  }, 30_000);
});
