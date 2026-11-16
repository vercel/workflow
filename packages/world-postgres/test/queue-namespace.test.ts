import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  getQueueTopicPrefix,
  IN_PROCESS_QUEUE_HANDLER,
  type InProcessDelivery,
  type QueueRouteHandler,
} from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createQueue } from '../src/queue.js';
import { TestPool } from './pool.js';

/**
 * The Workflow SDK registers its flow handler under the prefix the route was
 * built with (`WORKFLOW_QUEUE_NAMESPACE` at build time), while the World's
 * own prefix comes from its `namespace` option. When the two differ, the
 * World still runs its worker in the process that registered the flow
 * handler and delivers what the SDK publishes.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue: the flow handler prefix and the World namespace (integration)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let connectionString: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      pool = new TestPool({ connectionString, max: 6 });
    }, 120_000);

    afterEach(async () => {
      vi.unstubAllEnvs();
      await pool.query('TRUNCATE graphile_worker._private_jobs');
    });

    afterAll(async () => {
      await pool.end();
      await container.stop();
    });

    /** The SDK's flow handler: its in-process entry records what it got. */
    function flowHandler(delivered: string[]): QueueRouteHandler {
      return Object.assign(async () => Response.json({ ok: true }), {
        [IN_PROCESS_QUEUE_HANDLER]: async ({ meta }: InProcessDelivery) => {
          delivered.push(String(meta.messageId));
        },
      });
    }

    test('delivers to the flow handler registered for the default prefix when the World has a namespace of its own', async () => {
      // The route was built without a namespace, so the SDK registers for
      // `__wkf_workflow_` and publishes there; the World was given one.
      vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
      const sdkPrefix = getQueueTopicPrefix('workflow');
      const queue = createQueue(
        {
          connectionString,
          namespace: 'tenant',
          queueConcurrency: 2,
          applicationManagedShutdown: true,
        },
        pool
      );
      const delivered: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        queue.registerHandler(sdkPrefix, flowHandler(delivered));
        // Registered again, as a route that re-registers itself is (a
        // development rebuild, a worker module that registers twice).
        queue.registerHandler(sdkPrefix, flowHandler(delivered));
        await queue.start();
        const { messageId } = await queue.queue(`${sdkPrefix}test`, {
          runId: `wrun_${randomUUID()}`,
        });
        await expect
          .poll(() => delivered, { timeout: 10_000 })
          .toEqual([messageId]);
        // Said once, naming both prefixes and the variable to set; this
        // process is a worker, so it is not told that it only enqueues.
        const warnings = warn.mock.calls.map((call) => String(call[0]));
        expect(warnings.filter((w) => w.includes('only enqueues'))).toEqual([]);
        const mismatch = warnings.filter((w) =>
          w.includes('WORKFLOW_QUEUE_NAMESPACE')
        );
        expect(mismatch).toHaveLength(1);
        expect(mismatch[0]).toContain(`"${sdkPrefix}"`);
        expect(mismatch[0]).toContain(
          `"${getQueueTopicPrefix('workflow', 'tenant')}"`
        );
      } finally {
        warn.mockRestore();
        await queue.close();
      }
    }, 30_000);

    test('matching namespaces deliver as before, without a warning', async () => {
      vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'tenant');
      const prefix = getQueueTopicPrefix('workflow', 'tenant');
      const queue = createQueue(
        {
          connectionString,
          namespace: 'tenant',
          queueConcurrency: 2,
          applicationManagedShutdown: true,
        },
        pool
      );
      const delivered: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        queue.registerHandler(prefix, flowHandler(delivered));
        await queue.start();
        const { messageId } = await queue.queue(`${prefix}test`, {
          runId: `wrun_${randomUUID()}`,
        });
        await expect
          .poll(() => delivered, { timeout: 10_000 })
          .toEqual([messageId]);
        expect(
          warn.mock.calls
            .map((call) => String(call[0]))
            .filter(
              (w) =>
                w.includes('WORKFLOW_QUEUE_NAMESPACE') ||
                w.includes('only enqueues')
            )
        ).toEqual([]);
      } finally {
        warn.mockRestore();
        await queue.close();
      }
    }, 30_000);

    test("a process whose only handler is a queue consumer's starts no runner", async () => {
      vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
      const consumerPrefix = getQueueTopicPrefix('workflow', 'agent');
      const queue = createQueue(
        {
          connectionString,
          queueConcurrency: 2,
          applicationManagedShutdown: true,
        },
        pool
      );
      const served: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // A consumer's handler takes a request and has no in-process entry:
        // not the SDK's flow handler, so not a worker.
        queue.registerHandler(consumerPrefix, async (req) => {
          served.push(String(req.headers.get('x-workflow-message-id')));
          return Response.json({ ok: true });
        });
        await queue.start();
        const { messageId } = await queue.queue(`${consumerPrefix}test`, {
          runId: `wrun_${randomUUID()}`,
        });
        // Long enough for a runner (Graphile polls every 500 ms, and
        // LISTEN/NOTIFY wakes it sooner) to have claimed and delivered it.
        await sleep(3_000);
        expect(served).toEqual([]);
        const job = await pool.query(
          'SELECT locked_by FROM graphile_worker._private_jobs WHERE key = $1',
          [messageId]
        );
        expect(job.rows).toHaveLength(1);
        expect(job.rows[0].locked_by).toBeNull();
        // Told once that it only enqueues, as any process without the flow
        // handler is.
        expect(
          warn.mock.calls.filter((call) =>
            String(call[0]).includes('only enqueues')
          )
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
        await queue.close();
      }
    }, 30_000);
  }
);
