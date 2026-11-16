import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type QueueOptions,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  type World,
} from '@workflow/world';
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

// Every delivery here runs in this one process, where the runtime holds a
// second delivery of a running step back (its in-process single flight). A
// duplicate job is delivered by another process's worker in production, to
// another instance, where nothing holds it back: run every delivery as such.
vi.mock('../../core/dist/runtime/step-single-flight.js', () => ({
  runSingleFlight: (
    _runId: string,
    _correlationId: string,
    execute: () => Promise<unknown>
  ) => execute(),
}));

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 20_000
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

const SPEC_8 = SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM;

/**
 * Spec 8 publishes a run's step messages under their idempotency keys with
 * Graphile's \`preserve_run_at\`, and its runtime publishes them again after a
 * failed send. Next to a locked job, \`preserve_run_at\` inserts a second job,
 * which another process's worker delivers as a first delivery. This pins down
 * what that costs a spec 8 run (see queue-dedupe.test.ts for spec 9).
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue: a spec 8 step message sent again while its job is locked (real database and Graphile)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;

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
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    describe('a spec 8 run whose step messages are sent again while their bodies run', () => {
      let world: World & { start(): Promise<void> };
      let secondWorker: World;
      let server: Server;
      const oldPort = process.env.PORT;
      const oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
      const bodies: number[] = [];
      /** Sends each step message again exactly as first sent, by step. */
      const resends = new Map<string, () => Promise<unknown>>();
      const stepKeys: string[] = [];
      let lockedDuringResend = 0;
      let stepJobsAfterResend = 0;

      // Five branches: spec 8 runs up to three inline and queues the rest.
      const code = `
const once = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('dedupeOnce8');
async function resent8(n) {
  return await Promise.all([1, 2, 3, 4, 5].map((i) => once(n + i)));
}
globalThis.__private_workflows = new Map([['resent8', resent8]]);
`;

      beforeAll(async () => {
        const handler = workflowEntrypoint(code);
        server = createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          try {
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) {
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(',') : value
                );
            }
            const response = await handler(
              new Request(`http://localhost${req.url}`, {
                method: 'POST',
                headers,
                body: Buffer.concat(chunks),
              })
            );
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers)
            );
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
          queueConcurrency: 2,
          pollInterval: 50,
          applicationManagedShutdown: true,
        });
        const send = world.queue.bind(world);
        world.queue = async (name, message, opts) => {
          const stepId = (message as { stepId?: string }).stepId;
          if (stepId !== undefined && opts?.idempotencyKey) {
            stepKeys.push(opts.idempotencyKey);
            resends.set(stepId, () => send(name, message, opts));
          }
          return send(name, message, opts);
        };
        setWorld(world);
        await world.start();
        // A second process's workers, idle, to take a second job.
        secondWorker = createWorld({
          pool,
          queueConcurrency: 4,
          pollInterval: 50,
          applicationManagedShutdown: true,
        });
        await secondWorker.start?.();
        registerStepFunction('dedupeOnce8', async (n: number) => {
          bodies.push(n);
          if (resends.size > 0 && lockedDuringResend === 0) {
            // While the queued steps' jobs are being delivered, send their
            // messages again, as spec 8's runtime does after a failed
            // send (\`queueMessages\`).
            await until(
              async () =>
                (
                  await pool.query(
                    `SELECT count(*)::int AS n FROM graphile_worker._private_jobs
                      WHERE key = ANY($1) AND locked_at IS NOT NULL`,
                    [stepKeys]
                  )
                ).rows[0].n as number,
              (locked) => locked > 0,
              5_000
            ).catch(() => 0);
            lockedDuringResend = (
              await pool.query(
                `SELECT count(*)::int AS n FROM graphile_worker._private_jobs
                  WHERE key = ANY($1) AND locked_at IS NOT NULL`,
                [stepKeys]
              )
            ).rows[0].n;
            await Promise.all([...resends.values()].map((resend) => resend()));
            stepJobsAfterResend = (
              await pool.query(
                `SELECT count(*)::int AS n FROM graphile_worker._private_jobs
                  WHERE payload->>'idempotencyKey' = ANY($1)`,
                [stepKeys]
              )
            ).rows[0].n;
          }
          // Long enough for an idle worker to take a second job.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return n;
        });
      }, 120_000);

      afterAll(async () => {
        await secondWorker?.close?.();
        await world?.close?.();
        if (server) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
        }
        setWorld(undefined);
        if (oldPort === undefined) delete process.env.PORT;
        else process.env.PORT = oldPort;
        if (oldBaseUrl === undefined)
          delete process.env.WORKFLOW_LOCAL_BASE_URL;
        else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
      });

      it('runs each step body once', async () => {
        const runId = `wrun_${ulid()}`;
        await world.events.create(runId, {
          eventType: 'run_created',
          specVersion: SPEC_8,
          eventData: {
            deploymentId: 'postgres',
            workflowName: 'resent8',
            input: await dehydrateWorkflowArguments([0], runId, undefined),
            executionContext: { workflowCoreVersion: '5.0.0' },
          },
        });
        await world.queue('__wkf_workflow_resent8', {
          runId,
          runSpecVersion: SPEC_8,
        });

        await until(
          () => world.runs.get(runId),
          (run) => run.status === 'completed' || run.status === 'failed',
          40_000
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        // The scenario happened: queued steps, sent again while locked.
        expect(resends.size).toBeGreaterThan(0);
        expect(lockedDuringResend).toBeGreaterThan(0);
        expect([...bodies].sort()).toEqual([1, 2, 3, 4, 5]);
        expect(stepJobsAfterResend).toBeLessThanOrEqual(resends.size);
        expect((await world.runs.get(runId)).status).toBe('completed');
      }, 60_000);
    });
  }
);
