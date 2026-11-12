import { randomUUID } from 'node:crypto';
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
      try {
        queue.registerHandler(sdkPrefix, flowHandler(delivered));
        await queue.start();
        const { messageId } = await queue.queue(`${sdkPrefix}test`, {
          runId: `wrun_${randomUUID()}`,
        });
        await expect
          .poll(() => delivered, { timeout: 10_000 })
          .toEqual([messageId]);
      } finally {
        await queue.close();
      }
    }, 30_000);
  }
);
