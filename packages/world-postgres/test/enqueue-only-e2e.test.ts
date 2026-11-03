import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
// The conformance server harness `createTestSuite` runs on.
import {
  createFetcher,
  startServer,
} from '@workflow/world-testing/dist/src/util.mjs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createWorld } from '../src/index.js';

/**
 * A separate process that enqueues against a running Postgres app, with
 * queue auth on: the production shape `WORKFLOW_POSTGRES_ENQUEUE_ONLY` is for.
 * This test process is that producer (a script calling `start()`); the
 * spawned conformance server is the app, with its own Graphile worker. Run
 * enqueue-only, the producer starts no worker, so the app's worker takes the
 * job and delivers it to its own route with its own key: accepted, not
 * refused.
 */
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  test(
    "an enqueue-only producer's run is delivered by the app's worker, with queue auth on",
    { timeout: 90_000 },
    async () => {
      const server = await startServer({
        world: '@workflow/world-postgres',
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
      const fetcher = createFetcher(server);
      const port = server.info.port;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const connectionString = process.env.WORKFLOW_POSTGRES_URL;
      if (!connectionString) throw new Error('WORKFLOW_POSTGRES_URL is unset');
      const producer = createWorld({
        connectionString,
        queueConcurrency: 1,
        applicationManagedShutdown: true,
        enqueueOnly: true,
      });
      try {
        const manifest = (await fetch(
          `http://localhost:${port}/_manifest`
        ).then((response) => response.json())) as {
          workflows: Record<string, Record<string, { workflowId: string }>>;
        };
        const { workflowId } =
          manifest.workflows['workflows/addition.ts'].addition;
        // What `start()` in the producer does: write `run_created`, then
        // enqueue the run's first delivery.
        const created = (await producer.events.create(null, {
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            deploymentId: await producer.getDeploymentId(),
            workflowName: workflowId,
            input: new Uint8Array([1]),
          },
        } as never)) as { run?: { runId: string } };
        const runId = created.run?.runId;
        if (!runId) throw new Error('run_created returned no run');
        await producer.queue(`__wkf_workflow_${workflowId}` as never, {
          runId,
          requestedAt: new Date(),
        });

        // The app's route accepted the delivery: its runtime started the run.
        await vi.waitFor(
          async () => {
            const types = (await fetcher.getEvents(runId)).map(
              (event) => event.eventType
            );
            expect(types).toContain('run_started');
          },
          { interval: 200, timeout: 30_000 }
        );
        // Nothing was refused, on either side.
        const counters = (await fetch(
          `http://localhost:${port}/_counters/workflow.queue.delivery.refused`
        ).then((response) => response.json())) as {
          available: boolean;
          series: unknown[];
        };
        expect(counters).toEqual({ available: true, series: [] });
        expect(
          errors.mock.calls.some(([message]) =>
            String(message).includes('refused by the app as unauthenticated')
          )
        ).toBe(false);
        expect(
          warn.mock.calls.some(([message]) =>
            String(message).includes('Enqueue-only')
          )
        ).toBe(true);
      } finally {
        warn.mockRestore();
        errors.mockRestore();
        await producer.close?.();
      }
    }
  );
}
