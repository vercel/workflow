import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createWorkflowUrl } from '@workflow/utils';
import {
  getQueueTopicPrefix,
  IN_PROCESS_QUEUE_HANDLER,
  MessageId,
  type QueueRouteHandler,
  type World,
} from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { ulid } from 'ulid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
// These integration tests exercise the built runtime, like the conformance suite.
import {
  registerWorkflowHandler,
  setWorld,
  workflowEntrypoint,
} from '../../core/dist/runtime.js';
import { createWorld } from '../src/index.js';
import { TestPool } from './pool.js';

/**
 * The Postgres World delivers its messages in-process, so its flow route
 * (`POST /.well-known/workflow/v1/flow`) has no legitimate HTTP caller. In a
 * process that registered the flow handler (a worker), the runtime refuses
 * every request that reaches the route over HTTP with a 403, before reading
 * the body or touching any run; only the `?__health` probe keeps answering.
 * `WORKFLOW_QUEUE_AUTH=off` is the emergency override that makes the route
 * accept HTTP again, as it did before deliveries went in process.
 */
const code = `
async function noop() { return 'ok'; }
globalThis.__private_workflows = new Map([['noop', noop]]);
`;

const expectDenied = async (response: Response) => {
  expect(response.status).toBe(403);
  // Not the 401's "reload your key and retry" marker: final.
  expect(response.headers.get('x-workflow-auth-refused')).toBe(null);
  expect(await response.json()).toMatchObject({ code: 'QUEUE_ROUTE_DENIED' });
};

const FLOW_URL = createWorkflowUrl('http://localhost:3000', { type: 'flow' });

/**
 * A request to the flow route from outside the app: well-formed delivery
 * headers (the wire shape an earlier world-postgres worker sent) and a body
 * of the attacker's choosing.
 */
function forge(body: unknown, headers: Record<string, string> = {}) {
  return new Request(FLOW_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vqs-queue-name': `${getQueueTopicPrefix('workflow')}noop`,
      'x-vqs-message-id': `msg_${ulid()}`,
      'x-vqs-message-attempt': '1',
      'x-vqs-message-delivery-count': '1',
      'x-vqs-message-created-at': new Date().toISOString(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(process.platform === 'win32')(
  'Postgres flow route over HTTP (integration)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let world: World & { start(): Promise<void> };
    let handler: QueueRouteHandler;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new TestPool({
        connectionString: container.getConnectionUri(),
        max: 4,
      });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(
          new URL('../src/drizzle/migrations', import.meta.url)
        ),
        migrationsTable: 'workflow_migrations',
        migrationsSchema: 'workflow_drizzle',
      });
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      await utils.release();
      world = createWorld({ pool, applicationManagedShutdown: true });
      setWorld(world);
      // The app's flow route, as the framework integrations mount it, and
      // handed to the World as they do when the app starts: this process is a
      // worker.
      handler = workflowEntrypoint(code);
      expect(await registerWorkflowHandler(handler)).toBe(true);
    }, 120_000);

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    afterAll(async () => {
      setWorld(undefined);
      await world?.close?.();
      await pool?.end();
      await container?.stop();
    });

    it('declares deny for every process, registered or not', () => {
      expect(world.queueAuthMode).toBe('deny');
      // Not per prefix or per process: a process that never registered the
      // handler still serves the route, and the route must refuse there too.
      expect(world.queueAuthModeFor).toBeUndefined();
    });

    it('refuses a forged delivery before touching any run', async () => {
      const runId = `wrun_${ulid()}`;
      await expectDenied(await handler(forge({ runId })));
      // Nothing was written for the run the forged body named.
      await expect(world.runs.get(runId)).rejects.toThrow();
      const { rows } = await pool.query(
        'SELECT count(*)::int AS count FROM workflow.workflow_events WHERE run_id = $1',
        [runId]
      );
      expect(rows[0].count).toBe(0);
    });

    it('refuses a forged delivery that claims the executor lane', async () => {
      await expectDenied(
        await handler(
          forge(
            { runId: `wrun_${ulid()}`, invoke: true, requestId: 'req_forged' },
            {
              'x-workflow-postgres-executor-job': '1',
              'x-workflow-postgres-executor-worker': 'forged',
              'x-workflow-postgres-executor-attempt': '1',
            }
          )
        )
      );
    });

    it('refuses a forged delivery past the delivery cap', async () => {
      // Claiming a high attempt is how a forger fails a running run.
      await expectDenied(
        await handler(
          forge({ runId: `wrun_${ulid()}` }, { 'x-vqs-message-attempt': '49' })
        )
      );
    });

    it('refuses an HTTP delivery of a run while its in-process delivery is running (an old worker next to a new one)', async () => {
      // A rolling upgrade: a worker on an earlier release still POSTs the
      // run's deliveries over HTTP while this process runs them in process.
      // The HTTP one is refused at once, without waiting on the run's gate
      // (the refusal precedes the body), and the in-process one finishes.
      const runId = `wrun_${ulid()}`;
      const entry = handler[IN_PROCESS_QUEUE_HANDLER];
      if (!entry) throw new Error('the flow route has no in-process entry');
      const inFlight = entry({
        message: { runId },
        meta: {
          queueName: `${getQueueTopicPrefix('workflow')}noop`,
          messageId: MessageId.parse(`msg_${ulid()}`),
          attempt: 1,
          deliveryCount: 1,
        },
      });
      await expectDenied(await handler(forge({ runId })));
      // The in-process delivery reached the runtime's handler: the run does
      // not exist, so that handler rejects, which is its answer, not a
      // refusal.
      await expect(inFlight).rejects.toThrow();
    });

    it('WORKFLOW_QUEUE_AUTH=off makes the route accept HTTP again, as before deliveries went in process', async () => {
      vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
      const response = await handler(forge({ runId: `wrun_${ulid()}` }));
      // Handled, not refused: the handler ran the delivery (the run does not
      // exist, so it answers an error of its own).
      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(401);
    });

    it('WORKFLOW_QUEUE_AUTH=off is refused while dynamic workflows are enabled', async () => {
      vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
      vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', '1');
      await expectDenied(await handler(forge({ runId: `wrun_${ulid()}` })));
    });

    it('keeps the ?__health probe reachable', async () => {
      const response = await handler(
        new Request(`${FLOW_URL}?__health`, { method: 'POST' })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ healthy: true });
    });
  }
);
