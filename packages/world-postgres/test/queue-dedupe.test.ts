import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type QueueOptions,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
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
import { createQueue } from '../src/queue.js';
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

/**
 * A spec 9 run's keyed messages are sent again by later deliveries of the
 * run (the re-send rule), and rely on the queue to deduplicate them. These
 * tests run Graphile Worker against a real Postgres.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue deduplication of spec 9 keyed messages (real database and Graphile)',
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

    describe('a re-send of a step message', () => {
      let queue: ReturnType<typeof createQueue>;
      const oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;

      beforeAll(async () => {
        // A loopback target nothing listens on: the queue holds its runner
        // back until the target is reachable, so no job here is delivered.
        process.env.WORKFLOW_LOCAL_BASE_URL = 'http://127.0.0.1:9';
        queue = createQueue(
          { connectionString: container.getConnectionUri() },
          pool
        );
        await queue.start();
      });

      afterAll(async () => {
        await queue?.close();
        await pool.query(
          `DELETE FROM graphile_worker._private_jobs WHERE payload->>'id' = 'dedupe-step'`
        );
        if (oldBaseUrl === undefined)
          delete process.env.WORKFLOW_LOCAL_BASE_URL;
        else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
      });

      /** Sends the step message the runtime sends for `stepId`. */
      const sendStep = (stepId: string, opts: QueueOptions = {}) =>
        queue.queue(
          '__wkf_workflow_dedupe-step',
          {
            runId: 'wrun_dedupe',
            stepId,
            stepName: 'dedupe-step',
            runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          },
          { idempotencyKey: stepId, ...opts }
        );

      const jobsFor = async (stepId: string) =>
        (
          await pool.query<{
            attempts: number;
            run_at: Date;
            locked_at: Date | null;
            key: string | null;
          }>(
            `SELECT attempts, run_at, locked_at, key
               FROM graphile_worker._private_jobs
              WHERE payload->>'idempotencyKey' = $1
              ORDER BY id`,
            [stepId]
          )
        ).rows;

      it('adds no second job while the first one is locked', async () => {
        const stepId = `step_${ulid()}`;
        await sendStep(stepId, { delaySeconds: 3600 });
        // A worker took the job: it is being delivered.
        await pool.query(
          `UPDATE graphile_worker._private_jobs
              SET locked_at = now(), locked_by = 'other-worker'
            WHERE key = $1`,
          [stepId]
        );

        await sendStep(stepId);

        const jobs = await jobsFor(stepId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ key: stepId });
        expect(jobs[0]!.locked_at).not.toBeNull();
      });

      it('keeps the attempts and run_at of a job in retry backoff', async () => {
        const stepId = `step_${ulid()}`;
        await sendStep(stepId);
        await pool.query(
          `UPDATE graphile_worker._private_jobs
              SET attempts = 5, run_at = now() + interval '1 hour',
                  last_error = 'delivery failed'
            WHERE key = $1`,
          [stepId]
        );
        const [before] = await jobsFor(stepId);

        await sendStep(stepId);

        const jobs = await jobsFor(stepId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.attempts).toBe(5);
        expect(jobs[0]!.run_at.getTime()).toBe(before!.run_at.getTime());
      });

      it("adds no second job for a wait timer's hop sent again while the first waits out its delay", async () => {
        const key = `wait:wait_${ulid()}:7200000:3600000`;
        const sendHop = () =>
          queue.queue(
            '__wkf_workflow_dedupe-step',
            {
              runId: 'wrun_dedupe',
              waitContinuation: {
                correlationId: 'wait_dedupe',
                attempt: 0,
                resumeAtMs: 7_200_000,
                hopAtMs: 3_600_000,
              },
              runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
            },
            { idempotencyKey: key, delaySeconds: 3600 }
          );
        await sendHop();
        const [before] = await jobsFor(key);

        await sendHop();

        const jobs = await jobsFor(key);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.run_at.getTime()).toBe(before!.run_at.getTime());
      });

      it('adds a job again once the key is free', async () => {
        const stepId = `step_${ulid()}`;
        await sendStep(stepId);
        // Graphile deletes a job once its delivery completes.
        await pool.query(
          'DELETE FROM graphile_worker._private_jobs WHERE key = $1',
          [stepId]
        );

        await sendStep(stepId);

        expect(await jobsFor(stepId)).toHaveLength(1);
      });
    });

    describe('a spec 9 run whose step message is re-sent while its body runs', () => {
      let world: World & { start(): Promise<void> };
      let secondWorker: World;
      let server: Server;
      const oldPort = process.env.PORT;
      const oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
      const bodies: string[] = [];
      let resend: (() => Promise<unknown>) | undefined;
      let stepJobsDuringBody: number | undefined;
      let stepKey: string | undefined;

      const code = `
const once = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('dedupeOnce');
async function resent(n) { return await once(n); }
globalThis.__private_workflows = new Map([['resent', resent]]);
`;

      beforeAll(async () => {
        vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
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
        // One worker slot: while the step body holds it, a second job for
        // the step can only be taken by the other process's worker, whose
        // in-process duplicate check does not know the first delivery.
        world = createWorld({
          pool,
          queueConcurrency: 1,
          pollInterval: 50,
          applicationManagedShutdown: true,
        });
        // Every step message the runtime sends, so a test can send it again
        // exactly as the re-send rule does.
        const send = world.queue.bind(world);
        world.queue = async (name, message, opts) => {
          if ((message as { stepId?: string }).stepId !== undefined) {
            stepKey = opts?.idempotencyKey;
            resend = () => send(name, message, opts);
          }
          return send(name, message, opts);
        };
        setWorld(world);
        await world.start();
        // A second process's worker: a second job for the step would be
        // delivered by whichever worker takes it first.
        secondWorker = createWorld({
          pool,
          queueConcurrency: 4,
          pollInterval: 50,
          applicationManagedShutdown: true,
        });
        await secondWorker.start?.();
        registerStepFunction('dedupeOnce', async (n: number) => {
          bodies.push(`body-${n}`);
          if (bodies.length === 1) {
            // The orchestrator's re-send, while this delivery's job is
            // locked: the message was sent, so the queue must drop it.
            await resend?.();
            stepJobsDuringBody = (
              await pool.query(
                `SELECT count(*)::int AS n FROM graphile_worker._private_jobs
                  WHERE payload->>'idempotencyKey' = $1`,
                [stepKey]
              )
            ).rows[0].n;
            // Long enough for an idle worker to take a second job.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
          return n + 1;
        });
      }, 120_000);

      afterAll(async () => {
        vi.unstubAllEnvs();
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

      it('runs the step body once', async () => {
        const runId = `wrun_${ulid()}`;
        await world.events.create(runId, {
          eventType: 'run_created',
          specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          eventData: {
            deploymentId: 'postgres',
            workflowName: 'resent',
            input: await dehydrateWorkflowArguments([41], runId, undefined),
            executionContext: { workflowCoreVersion: '5.0.0' },
          },
        });
        await world.queue('__wkf_workflow_resent', {
          runId,
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        });

        await until(
          () => world.runs.get(runId),
          (run) => run.status === 'completed' || run.status === 'failed'
        );
        // Long enough for a second job, had one been added, to be delivered.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        expect(resend).toBeDefined();
        // The re-send found the locked job and added none.
        expect(stepJobsDuringBody).toBe(1);
        expect(bodies).toEqual(['body-41']);
        const { data: events } = await world.events.list({ runId });
        expect(
          events.filter((event) => event.eventType === 'step_started')
        ).toHaveLength(1);
        expect((await world.runs.get(runId)).status).toBe('completed');
      });
    });
  }
);
