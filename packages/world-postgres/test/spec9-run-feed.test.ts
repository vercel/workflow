import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR, type World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// These integration tests exercise the built runtime, like the conformance suite.
import { registerStepFunction } from '../../core/dist/private.js';
import { setWorld, workflowEntrypoint } from '../../core/dist/runtime.js';
import { dehydrateWorkflowArguments } from '../../core/dist/serialization.js';
import { createWorld } from '../src/index.js';
import { TestPool } from './pool.js';

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for integration state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;
const BRANCHES = 8;

/**
 * A spec 9 fan-out on world-postgres, end to end through the runtime: the
 * orchestrator sees its background steps' outcomes on the live feed
 * (`events.subscribe` over LISTEN/NOTIFY) while it lingers, and the wakes
 * the steps send queue behind it on the run's named queue, where its
 * delivery covers them with a re-run instead of one delivery each.
 */
describe.skipIf(process.platform === 'win32')(
  'a spec 9 fan-out on world-postgres (real database, Graphile and runtime)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let world: World & { start(): Promise<void> };
    let server: Server;
    const oldPort = process.env.PORT;
    const oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    /** Orchestrator deliveries (no `stepId`), by run. */
    const orchestratorDeliveries = new Map<string, number>();

    const code = `
const work = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('fanOutWork');
async function fanOut(n) {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => work(i))
  );
  return results.reduce((sum, value) => sum + value, 0);
}
globalThis.__private_workflows = new Map([['fanOut', fanOut]]);
`;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new TestPool({
        connectionString: container.getConnectionUri(),
        max: 20,
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

      // Every step runs from its own message.
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      const handler = workflowEntrypoint(code);
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        try {
          const message = JSON.parse(body.toString()) as {
            runId?: string;
            stepId?: string;
          };
          if (message.runId && message.stepId === undefined) {
            orchestratorDeliveries.set(
              message.runId,
              (orchestratorDeliveries.get(message.runId) ?? 0) + 1
            );
          }
        } catch {}
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(',') : value);
          }
          const response = await handler(
            new Request(`http://localhost${req.url}`, {
              method: 'POST',
              headers,
              body,
            })
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No test server address');
      process.env.PORT = String(address.port);
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
      world = createWorld({
        pool,
        // Few slots: at most half of them linger on a feed, so the steps a
        // lingering orchestrator waits for still get one.
        queueConcurrency: 4,
        pollInterval: 50,
        applicationManagedShutdown: true,
      });
      setWorld(world);
      await world.start();
      registerStepFunction('fanOutWork', async (i: number) => {
        await new Promise((resolve) => setTimeout(resolve, 100 + i * 20));
        return i;
      });
    }, 120_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      await world?.close?.();
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      setWorld(undefined);
      await pool?.end();
      await container?.stop();
      if (oldPort === undefined) delete process.env.PORT;
      else process.env.PORT = oldPort;
      if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
      else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
    });

    async function startRun(): Promise<string> {
      const runId = `wrun_${ulid()}`;
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: SPEC,
        eventData: {
          deploymentId: 'postgres',
          workflowName: 'fanOut',
          input: await dehydrateWorkflowArguments([BRANCHES], runId, undefined),
          executionContext: { workflowCoreVersion: '5.0.0' },
        },
      });
      await world.queue('__wkf_workflow_fanOut', {
        runId,
        runSpecVersion: SPEC,
      });
      return runId;
    }

    it('completes with far fewer orchestrator deliveries than step wakes', async () => {
      const runId = await startRun();
      const run = await until(
        () => world.runs.get(runId),
        (current) =>
          current.status === 'completed' || current.status === 'failed'
      );
      expect(run.status).toBe('completed');
      // Every wake left queued is covered or delivered by now.
      await until(
        async () =>
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM graphile_worker.jobs
                WHERE queue_name LIKE $1`,
              [`%:${runId}:executor`]
            )
          ).rows[0].n as number,
        (n) => n === 0
      );
      const { data: events } = await world.events.list({ runId });
      expect(
        events.filter((event) => event.eventType === 'step_completed')
      ).toHaveLength(BRANCHES);
      // Without the feed and coalescing, each of the BRANCHES wakes is its
      // own orchestrator delivery after the first.
      expect(orchestratorDeliveries.get(runId)).toBeLessThanOrEqual(3);
    }, 60_000);

    it('runs several fan-outs at once without starving their steps of worker slots', async () => {
      const runIds = await Promise.all(
        Array.from({ length: 4 }, () => startRun())
      );
      const runs = await Promise.all(
        runIds.map((runId) =>
          until(
            () => world.runs.get(runId),
            (current) =>
              current.status === 'completed' || current.status === 'failed',
            45_000
          )
        )
      );
      expect(runs.map((run) => run.status)).toEqual(
        runIds.map(() => 'completed')
      );
    }, 60_000);
  }
);
