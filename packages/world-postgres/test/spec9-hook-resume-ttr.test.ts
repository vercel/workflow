import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
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
import {
  resumeHook,
  setWorld,
  workflowEntrypoint,
} from '../../core/dist/runtime.js';
import { dehydrateWorkflowArguments } from '../../core/dist/serialization.js';
import { createWorld } from '../src/index.js';
import { TestPool } from './pool.js';

// The runtime's own OpenTelemetry API and SDK (world-postgres depends on
// neither): the tracer provider registered here is the one the runtime
// reports its spans to.
const coreRequire = createRequire(
  new URL('../../core/package.json', import.meta.url)
);
const { trace: otelTrace } = coreRequire(
  '@opentelemetry/api'
) as typeof import('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
  coreRequire(
    '@opentelemetry/sdk-trace-base'
  ) as typeof import('@opentelemetry/sdk-trace-base');

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
const TOTAL_KEY = 'workflow.resume.total_ms';

/**
 * Hook-resume latency (`workflow.resume.total_ms`) on world-postgres while
 * the run's delivery lingers on the live feed. The feed leaves a
 * `resumeHook()` resume to its wake, which carries the producer's timing, so
 * the resume is measured as it is without a feed.
 */
describe.skipIf(process.platform === 'win32')(
  'hook-resume latency on a lingering spec 9 delivery (real database, Graphile, runtime and tracer)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let world: World & { start(): Promise<void> };
    let server: Server;
    const oldPort = process.env.PORT;
    const oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider();

    const code = `
const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
const afterResume = useStep('ttrAfterResume');
async function resumed(token) {
  const hook = createHook({ token });
  const value = await hook;
  return await afterResume(value);
}
globalThis.__private_workflows = new Map([['resumed', resumed]]);
`;

    beforeAll(async () => {
      tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
      otelTrace.setGlobalTracerProvider(tracerProvider);
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

      // Long enough that the resume lands while the delivery still lingers.
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS', '20000');
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '20000');
      const handler = workflowEntrypoint(code);
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
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
              body: Buffer.concat(chunks),
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
        queueConcurrency: 4,
        pollInterval: 50,
        applicationManagedShutdown: true,
      });
      setWorld(world);
      await world.start();
      registerStepFunction('ttrAfterResume', async (value: string) => value);
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
      await tracerProvider.shutdown();
      otelTrace.disable();
      await pool?.end();
      await container?.stop();
      if (oldPort === undefined) delete process.env.PORT;
      else process.env.PORT = oldPort;
      if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
      else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
    });

    it('measures a resume that lands while the delivery lingers on the feed', async () => {
      const runId = `wrun_${ulid()}`;
      const token = `ttr-${ulid()}`;
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: SPEC,
        eventData: {
          deploymentId: 'postgres',
          workflowName: 'resumed',
          input: await dehydrateWorkflowArguments([token], runId, undefined),
          executionContext: { workflowCoreVersion: '5.0.0' },
        },
      });
      await world.queue('__wkf_workflow_resumed', {
        runId,
        runSpecVersion: SPEC,
      });
      // The run waits on its hook; its delivery is lingering on the feed.
      await until(
        async () => (await world.events.list({ runId })).data,
        (events) => events.some((event) => event.eventType === 'hook_created')
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      spanExporter.reset();

      await resumeHook(token, 'payload');

      const run = await until(
        () => world.runs.get(runId),
        (current) =>
          current.status === 'completed' || current.status === 'failed'
      );
      expect(run.status).toBe('completed');
      const samples = spanExporter
        .getFinishedSpans()
        .filter((span) => span.attributes[TOTAL_KEY] !== undefined);
      expect(samples).toHaveLength(1);
      expect(samples[0]!.attributes[TOTAL_KEY]).toBeGreaterThan(0);
    }, 60_000);
  }
);
