import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerStepFunction } from '../../core/dist/private.js';
// These integration tests exercise the built runtime, like the conformance suite.
import {
  getRun,
  resumeHook,
  setWorld,
  workflowEntrypoint,
} from '../../core/dist/runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../../core/dist/serialization.js';
import { createWorld } from '../src/index.js';
import { createInvocations } from '../src/invocations.js';

const code = `
const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
const sendHook = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('invokeSendHook');
async function oneHook(token) { return await createHook({ token }); }
async function twoHooks(tokens) {
  const a = createHook({ token: tokens[0] });
  const b = createHook({ token: tokens[1] });
  return [await a, await b];
}
async function selfHook(token) {
  const hook = createHook({ token });
  return await Promise.all([hook, sendHook(token)]);
}
globalThis.__private_workflows = new Map([
  ['oneHook', oneHook], ['twoHooks', twoHooks], ['selfHook', selfHook]
]);
`;

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for integration state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform === 'win32')(
  'Postgres invoke (real database and Graphile)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: Pool;
    let world: World & { start(): Promise<void> };
    let secondWorker: World;
    let server: Server;
    let transport: ReturnType<typeof createInvocations>;
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const oldPort = process.env.PORT;
    const oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new Pool({
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
      const handler = workflowEntrypoint(code);
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const payload = JSON.parse(body.toString());
        const runId = payload.stepId ? undefined : payload.runId;
        if (runId) {
          const count = (active.get(runId) ?? 0) + 1;
          active.set(runId, count);
          maximum.set(runId, Math.max(count, maximum.get(runId) ?? 0));
        }
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
        } finally {
          if (runId) active.set(runId, (active.get(runId) ?? 1) - 1);
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
        enableInvoke: true,
        queueConcurrency: 4,
        applicationManagedShutdown: true,
      });
      setWorld(world);
      await world.start();
      // Two real Graphile runner instances compete for the same task/queue.
      secondWorker = createWorld({
        pool,
        enableInvoke: true,
        queueConcurrency: 4,
        applicationManagedShutdown: true,
      });
      await secondWorker.start?.();
      transport = createInvocations(pool);
      registerStepFunction('invokeSendHook', async (token: string) => {
        await resumeHook(token, 'from-step');
        return 'sent';
      });
    }, 120_000);

    afterAll(async () => {
      transport?.close();
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
      if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
      else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
      await pool?.end();
      await container?.stop();
    });

    async function start(name: string, args: unknown[], engine = 'node') {
      const runId = `wrun_${ulid()}`;
      const input = await dehydrateWorkflowArguments(args, runId, undefined);
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'postgres',
          workflowName: name,
          input,
          executionContext: {
            workflowCoreVersion: '5.0.0',
            workflowVm: engine,
          },
        },
      });
      await world.queue(`__wkf_workflow_${name}`, { runId });
      return runId;
    }

    async function hook(token: string) {
      return until(
        () => world.hooks.getByToken(token).catch(() => null),
        (value) => value !== null
      );
    }

    for (const engine of ['node', 'quickjs']) {
      it(`persists an invoked hook and completes a workflow (${engine})`, async () => {
        const token = randomUUID();
        const runId = await start('oneHook', [token], engine);
        await hook(token);
        await resumeHook(token, { answer: 42 });
        const events = await world.events.list({ runId });
        expect(
          events.data.filter((event) => event.eventType === 'hook_received')
        ).toHaveLength(1);
        await until(
          () => world.runs.get(runId),
          (run) => run.status === 'completed' || run.status === 'failed'
        );
        await expect(getRun(runId).returnValue).resolves.toEqual({
          answer: 42,
        });
        expect(maximum.get(runId)).toBe(1);
      });
    }

    it('delivers two hooks through one run queue, with another run free to execute', async () => {
      const tokens = [randomUUID(), randomUUID()];
      const runId = await start('twoHooks', [tokens]);
      const otherToken = randomUUID();
      const otherRun = await start('oneHook', [otherToken]);
      await Promise.all([...tokens, otherToken].map(hook));
      await Promise.all([
        resumeHook(tokens[0], 'a'),
        resumeHook(tokens[1], 'b'),
        resumeHook(otherToken, 'other'),
      ]);
      await until(
        () => world.runs.get(runId),
        (run) => run.status === 'completed' || run.status === 'failed'
      );
      await expect(getRun(runId).returnValue).resolves.toEqual(['a', 'b']);
      await expect(getRun(otherRun).returnValue).resolves.toEqual('other');
      const rows = await pool.query(
        'SELECT responded_at FROM workflow.workflow_invocations WHERE run_id = $1',
        [runId]
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((row) => row.responded_at)).toBe(true);
      expect(maximum.get(runId)).toBe(1);
    });

    it('responds to a hook sent by an executing step without waiting for that step to return', async () => {
      const runId = await start('selfHook', [randomUUID()]);
      await until(
        () => world.runs.get(runId),
        (run) => run.status === 'completed' || run.status === 'failed'
      );
      await expect(getRun(runId).returnValue).resolves.toEqual([
        'from-step',
        'sent',
      ]);
      expect(maximum.get(runId)).toBe(1);
      const events = await world.events.list({ runId });
      const stepStart = events.data.find(
        (event) => event.eventType === 'step_started'
      );
      expect(stepStart?.eventData).toMatchObject({
        ownerMessageId: expect.any(String),
      });
    });

    it('replays a stored result but still enqueues a wake for every invoke', async () => {
      const runId = `transport-${randomUUID()}`;
      const requestId = randomUUID();
      let wakes = 0;
      const enqueue = async (client: import('pg').PoolClient) => {
        await client.query(
          'SELECT graphile_worker.add_job($1, $2::json, queue_name => $3)',
          ['transport_test', JSON.stringify({ runId }), `transport:${runId}`]
        );
        wakes++;
      };
      const first = transport.invoke(
        runId,
        { value: new Uint8Array([1, 2]) },
        { idempotencyKey: requestId },
        enqueue
      );
      await until(
        () => transport.pending(runId),
        (rows) => rows.length === 1
      );
      const feed = transport.feed(runId, await transport.pending(runId));
      const delivery = await feed.next();
      if (delivery.done) throw new Error('Missing delivery');
      expect(delivery.value.payload).toEqual({ value: new Uint8Array([1, 2]) });
      await delivery.value.respond({ status: 'accepted' });
      await expect(first).resolves.toEqual({ status: 'accepted' });
      await expect(
        transport.invoke(
          runId,
          { value: new Uint8Array([1, 2]) },
          { idempotencyKey: requestId },
          enqueue
        )
      ).resolves.toEqual({ status: 'accepted' });
      expect(wakes).toBe(2);
      await expect(
        transport.invoke(
          runId,
          { value: 3 },
          { idempotencyKey: requestId },
          enqueue
        )
      ).rejects.toThrow('different contents');
      expect(wakes).toBe(2);
      await feed.return?.();
    });

    it('replays committed input even if its response was stored before the executor stopped', async () => {
      const token = randomUUID();
      const runId = await start('oneHook', [token]);
      const target = await hook(token);
      if (!target) throw new Error('Missing hook');
      await until(
        async () => active.get(runId) ?? 0,
        (count) => count === 0
      );
      const payload = await dehydrateStepReturnValue(
        'recovered',
        runId,
        undefined,
        []
      );
      const request = {
        type: 'hook_resume',
        version: 1,
        hookId: target.hookId,
        token,
        payload,
      };
      const idempotencyKey = randomUUID();
      // Stage the state at the crash boundary: event + response persisted,
      // but workflow execution has not observed either yet.
      const sent = transport.invoke(
        runId,
        request,
        { idempotencyKey },
        async () => {}
      );
      await until(
        () => transport.pending(runId),
        (rows) => rows.length === 1
      );
      const feed = transport.feed(runId, await transport.pending(runId));
      const delivery = await feed.next();
      if (delivery.done) throw new Error('Missing delivery');
      await world.events.create(runId, {
        eventType: 'hook_received',
        correlationId: target.hookId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { token, payload },
      });
      await delivery.value.respond({ status: 'accepted' });
      await sent;
      await feed.return?.();
      expect(await transport.pending(runId)).toEqual([]);
      await world.invoke!(runId, request, { idempotencyKey });
      await until(
        () => world.runs.get(runId),
        (run) => run.status === 'completed' || run.status === 'failed'
      );
      await expect(getRun(runId).returnValue).resolves.toBe('recovered');
      const events = await world.events.list({ runId });
      expect(
        events.data.filter((event) => event.eventType === 'hook_received')
      ).toHaveLength(1);
    });

    it('rolls back the input when wake enqueue fails', async () => {
      const runId = randomUUID();
      await expect(
        transport.invoke(runId, {}, undefined, async () => {
          throw new Error('enqueue failed');
        })
      ).rejects.toThrow('enqueue failed');
      expect(await transport.pending(runId)).toEqual([]);
    });

    it('leaves timed-out input pending and cancels a blocked feed read on return', async () => {
      const runId = randomUUID();
      await expect(
        transport.invoke(runId, {}, { timeoutMs: 10 }, async () => {})
      ).rejects.toThrow('outcome is unknown');
      expect(await transport.pending(runId)).toHaveLength(1);
      const feed = transport.feed('empty', []);
      const next = feed.next();
      await feed.return?.();
      await expect(next).resolves.toMatchObject({ done: true });
    });
  }
);
