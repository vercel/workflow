import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createWorkflowUrl } from '@workflow/utils';
import { getQueueTopicPrefix, type World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// These integration tests exercise the built runtime, like the conformance suite.
import { setWorld, workflowEntrypoint } from '../../core/dist/runtime.js';
import { createWorld } from '../src/index.js';
import { TestPool } from './pool.js';

/**
 * The Postgres World delivers its messages in-process, so its flow route
 * (`POST /.well-known/workflow/v1/flow`) has no legitimate HTTP caller. The
 * runtime refuses every request that reaches it over HTTP before reading the
 * body or touching any run; only the `?__health` probe keeps answering.
 */
const code = `
async function noop() { return 'ok'; }
globalThis.__private_workflows = new Map([['noop', noop]]);
`;

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
    let handler: (req: Request) => Promise<Response>;

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
      // The app's flow route, as the framework integrations mount it.
      handler = workflowEntrypoint(code);
    }, 120_000);

    afterAll(async () => {
      setWorld(undefined);
      await world?.close?.();
      await pool?.end();
      await container?.stop();
    });

    it('refuses a forged delivery before touching any run', async () => {
      const runId = `wrun_${ulid()}`;
      const response = await handler(forge({ runId }));
      expect(response.status).toBe(401);
      expect(response.headers.get('x-workflow-auth-refused')).toBe('1');
      expect(await response.json()).toMatchObject({
        code: 'QUEUE_AUTH_REFUSED',
      });
      // Nothing was written for the run the forged body named.
      await expect(world.runs.get(runId)).rejects.toThrow();
      const { rows } = await pool.query(
        'SELECT count(*)::int AS count FROM workflow.workflow_events WHERE run_id = $1',
        [runId]
      );
      expect(rows[0].count).toBe(0);
    });

    it('refuses a forged delivery that claims the executor lane', async () => {
      const response = await handler(
        forge(
          { runId: `wrun_${ulid()}`, invoke: true, requestId: 'req_forged' },
          {
            'x-workflow-postgres-executor-job': '1',
            'x-workflow-postgres-executor-worker': 'forged',
            'x-workflow-postgres-executor-attempt': '1',
          }
        )
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('x-workflow-auth-refused')).toBe('1');
    });

    it('refuses a forged delivery past the delivery cap', async () => {
      // Claiming a high attempt is how a forger fails a running run.
      const response = await handler(
        forge({ runId: `wrun_${ulid()}` }, { 'x-vqs-message-attempt': '49' })
      );
      expect(response.status).toBe(401);
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
