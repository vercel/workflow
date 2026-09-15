import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { encode } from 'cbor-x';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../core/dist/private.js';
import { handleInvocation } from '../../core/dist/runtime/invocations.js';
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
import {
  createInvocationNotifications,
  INVOCATION_INPUT_TOPIC,
  INVOCATION_RESULT_TOPIC,
  invocationNotificationKey,
} from '../src/invocation-notifications.js';
import { createInvocations } from '../src/invocations.js';
import { MessageData } from '../src/message.js';
import { createQueue } from '../src/queue.js';

const code = `
const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
const sendHook = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('invokeSendHook');
const holdStep = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('invokeHoldStep');
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
async function heldHook(token) {
  const hook = createHook({ token });
  return await Promise.all([hook, holdStep()]);
}
globalThis.__private_workflows = new Map([
  ['oneHook', oneHook], ['twoHooks', twoHooks], ['selfHook', selfHook], ['heldHook', heldHook]
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
    const overrides = new Map<string, (req: Request) => Promise<Response>>();
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
          const response = await (overrides.get(payload.runId) ?? handler)(
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
      await transport?.close();
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

    async function seedTransportRun(
      runId: string,
      attributes: Record<string, string> = {}
    ) {
      await pool.query(
        `INSERT INTO workflow.workflow_runs(id, name, deployment_id, status, spec_version, attributes)
         VALUES ($1, 'transport_test', 'postgres', 'running', 7, $2::jsonb)`,
        [runId, JSON.stringify(attributes)]
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

    it('replays after a slow hook commit even when the invocation has only one wake', async () => {
      const token = randomUUID();
      const runId = await start('oneHook', [token]);
      await hook(token);
      await until(
        async () => active.get(runId) ?? 0,
        (count) => count === 0
      );
      const original = world.events.create;
      const write = vi
        .spyOn(world.events, 'create')
        .mockImplementation(async (...args) => {
          if (args[0] === runId && args[1].eventType === 'hook_received') {
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
          return original(...args);
        });
      try {
        await resumeHook(token, 'slow input');
        await until(
          () => world.runs.get(runId),
          (run) => run.status === 'completed'
        );
        await expect(getRun(runId).returnValue).resolves.toBe('slow input');
      } finally {
        write.mockRestore();
      }
    });

    it.each([
      new WorkflowWorldError('invalid field', {
        status: 422,
        code: 'INVALID_ARGUMENT',
        field: 'payload',
        retryAfter: 5,
      }),
      new EntityConflictError('already changed'),
      new HookNotFoundError('gone-token'),
      new WorkflowRunNotFoundError('missing-run'),
      new RunExpiredError(
        'expired',
        'expired-run',
        'completed',
        new Date('2026-01-01')
      ),
    ])('returns persisted $name outcomes instead of timing out', async (error) => {
      const runId = `wrun_${ulid()}`;
      await seedTransportRun(runId);
      const requestId = randomUUID();
      let deliveries = 0;
      overrides.set(
        runId,
        world.createQueueHandler('__wkf_workflow_', async (message) => {
          if ((message as { invoke?: boolean }).invoke) {
            deliveries++;
            throw error;
          }
        })
      );
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const restored = await world.invoke!(
            runId,
            {},
            { idempotencyKey: requestId, timeoutMs: 5000 }
          ).catch((err) => err);
          expect(restored).toBeInstanceOf(error.constructor);
          for (const key of Object.getOwnPropertyNames(error)) {
            expect(Reflect.get(restored, key)).toEqual(Reflect.get(error, key));
          }
          expect(restored.message).toBe(error.message);
        }
        expect(deliveries).toBe(1);
        const rows = await pool.query(
          'SELECT result_version, responded_at FROM workflow.workflow_invocations WHERE run_id = $1',
          [runId]
        );
        expect(rows.rows[0]).toMatchObject({
          result_version: 1,
          responded_at: expect.any(Date),
        });
        await until(
          async () =>
            (
              await pool.query(
                'SELECT id FROM graphile_worker.jobs WHERE queue_name = $1',
                [`workflow_flows:${runId}:executor`]
              )
            ).rowCount,
          (count) => count === 0
        );
      } finally {
        overrides.delete(runId);
      }
    });

    it('reads legacy results without treating error-looking values as envelopes', async () => {
      const runId = `transport-${randomUUID()}`;
      await seedTransportRun(runId);
      const id = randomUUID();
      const value = {
        ok: false,
        error: { name: 'Error', message: 'application data', fields: {} },
      };
      const result = transport.invoke(
        runId,
        {},
        { idempotencyKey: id },
        async () => {}
      );
      await until(
        () => transport.pending(runId),
        (rows) => rows.length === 1
      );
      await pool.query(
        'UPDATE workflow.workflow_invocations SET result = $3, responded_at = now() WHERE run_id = $1 AND request_id = $2',
        [runId, id, Buffer.from(encode(value))]
      );
      await expect(result).resolves.toEqual(value);
      await expect(
        transport.respond(runId, id, value)
      ).resolves.toBeUndefined();
    });

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

    it('moves a legacy job behind an active executor instead of starting a second input consumer', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      registerStepFunction('invokeHoldStep', async () => {
        entered.resolve();
        await release.promise;
        return 'released';
      });
      const token = randomUUID();
      const runId = await start('heldHook', [token]);
      try {
        await entered.promise;
        expect(active.get(runId)).toBe(1);
        const messageId = `msg_legacy_${randomUUID()}`;
        const legacy = MessageData.encode({
          id: 'heldHook',
          data: Buffer.from(JSON.stringify({ runId })),
          messageId: messageId as MessageData['messageId'],
          attempt: 1,
        });
        await pool.query('SELECT graphile_worker.add_job($1, $2::json)', [
          'workflow_flows',
          JSON.stringify(legacy),
        ]);
        const transferred = await until(
          async () =>
            (
              await pool.query<{
                task_identifier: string;
                queue_name: string;
              }>(
                'SELECT task_identifier, queue_name FROM graphile_worker.jobs WHERE key = $1',
                [`workflow_flows_executor:transfer:${messageId}`]
              )
            ).rows[0],
          (row) => row !== undefined
        );
        expect(transferred).toEqual({
          task_identifier: 'workflow_flows_executor',
          queue_name: `workflow_flows:${runId}:executor`,
        });
        await resumeHook(token, 'input');
        // The existing executor accepted the input while the step was held.
        // The legacy wake is queued, not another HTTP executor invocation.
        expect(active.get(runId)).toBe(1);
        expect(maximum.get(runId)).toBe(1);
      } finally {
        release.resolve();
      }
      await until(
        () => world.runs.get(runId),
        (run) => run.status === 'completed' || run.status === 'failed'
      );
      await expect(getRun(runId).returnValue).resolves.toEqual([
        'input',
        'released',
      ]);
      expect(maximum.get(runId)).toBe(1);
    });

    it('replays a stored result but still enqueues a wake for every invoke', async () => {
      const runId = `transport-${randomUUID()}`;
      await seedTransportRun(runId);
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
      await transport.respond(runId, delivery.value.id, { status: 'accepted' });
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

    it('characterizes admitted writes continuing after the Graphile claim is revoked', async () => {
      const runId = `wrun_${ulid()}`;
      const hookId = `hook_${ulid()}`;
      const token = randomUUID();
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'postgres',
          workflowName: 'oneHook',
          input: await dehydrateWorkflowArguments([token], runId, undefined),
        },
      });
      await world.events.create(runId, { eventType: 'run_started' });
      await world.events.create(runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      let lateWrite = false;
      overrides.set(
        runId,
        world.createQueueHandler('__wkf_workflow_', async () => {
          calls++;
          if (calls !== 1) return;
          entered.resolve();
          await release.promise;
          // This write is intentionally NOT fenced by the earlier HTTP admission
          // check. The test records the limitation, rather than claiming safety.
          await world.events.create(runId, {
            eventType: 'hook_received',
            correlationId: hookId,
            eventData: { token, payload: new Uint8Array([1]) },
          });
          lateWrite = true;
        })
      );
      const utils = await makeWorkerUtils({ pgPool: pool });
      try {
        await world.queue('__wkf_workflow_oneHook', { runId });
        await entered.promise;
        const job = (
          await pool.query<{ locked_by: string }>(
            'SELECT locked_by FROM graphile_worker.jobs WHERE queue_name = $1 AND locked_by IS NOT NULL',
            [`workflow_flows:${runId}:executor`]
          )
        ).rows[0];
        expect(job).toBeDefined();
        await utils.forceUnlockWorkers([job.locked_by]);
        await until(
          async () =>
            (
              await pool.query<{ locked_by: string | null }>(
                'SELECT locked_by FROM graphile_worker.jobs WHERE queue_name = $1',
                [`workflow_flows:${runId}:executor`]
              )
            ).rows[0]?.locked_by,
          (owner) => owner !== job.locked_by
        );
        release.resolve();
        await until(async () => lateWrite, Boolean);
        await until(
          async () => active.get(runId) ?? 0,
          (n) => n === 0
        );
        expect(lateWrite).toBe(true);
      } finally {
        release.resolve();
        await until(
          async () => active.get(runId) ?? 0,
          (n) => n === 0
        );
        overrides.delete(runId);
        await utils.release();
        await world.events.create(runId, { eventType: 'run_cancelled' });
      }
    });

    it('deduplicates an event committed before response storage, including after disposal and completion', async () => {
      const token = randomUUID();
      const runId = await start('oneHook', [token]);
      const target = await hook(token);
      if (!target) throw new Error('Missing hook');
      await until(
        async () => active.get(runId) ?? 0,
        (count) => count === 0
      );
      const payload = await dehydrateStepReturnValue(
        'once',
        runId,
        undefined,
        []
      );
      const input = {
        type: 'hook_resume',
        version: 1,
        hookId: target.hookId,
        token,
        payload,
      };
      const id = randomUUID();
      // The first executor wrote the event and returned, but its response was
      // lost before World stored it. Re-delivery must not append a second event.
      await expect(handleInvocation(world, runId, id, input)).resolves.toEqual({
        status: 'accepted',
      });
      await world.events.create(runId, {
        eventType: 'hook_disposed',
        correlationId: target.hookId,
      });
      await expect(
        Promise.all([
          handleInvocation(world, runId, id, input),
          handleInvocation(world, runId, id, input),
        ])
      ).resolves.toEqual([{ status: 'accepted' }, { status: 'accepted' }]);
      await expect(
        handleInvocation(world, runId, id, {
          ...input,
          payload: new Uint8Array([99]),
        })
      ).rejects.toMatchObject({ status: 422 });
      await world.queue('__wkf_workflow_oneHook', { runId });
      await until(
        () => world.runs.get(runId),
        (run) => run.status === 'completed' || run.status === 'failed'
      );
      await expect(getRun(runId).returnValue).resolves.toBe('once');
      await expect(handleInvocation(world, runId, id, input)).resolves.toEqual({
        status: 'accepted',
      });
      const events = await world.events.list({ runId });
      const receives = events.data.filter(
        (event) => event.eventType === 'hook_received'
      );
      expect(receives).toHaveLength(1);
      expect(receives[0].resumeId).toBe(id);
    });

    it('purges invocation inputs/results at zero retention and prevents late recreation', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId, { $retention: '0' });
      const firstId = randomUUID();
      const first = transport.invoke(
        runId,
        { secret: 'input' },
        { idempotencyKey: firstId },
        async () => {}
      );
      await until(
        () => transport.pending(runId),
        (rows) => rows.length === 1
      );
      await transport.respond(runId, firstId, { secret: 'result' });
      await first;
      const pendingId = randomUUID();
      const waiting = transport.invoke(
        runId,
        { secret: 'pending' },
        { idempotencyKey: pendingId },
        async () => {}
      );
      const expired = expect(waiting).rejects.toMatchObject({
        status: 410,
        code: 'INVOCATION_DATA_EXPIRED',
      });
      await until(
        () => transport.pending(runId),
        (rows) => rows.length === 1
      );
      await world.events.create(runId, {
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_CURRENT,
      });
      await expired;
      await transport.respond(runId, pendingId, { secret: 'late response' });
      await expect(
        transport.invoke(
          runId,
          { secret: 'late input' },
          undefined,
          async () => {}
        )
      ).rejects.toMatchObject({ status: 410 });
      const { rows } = await pool.query(
        'SELECT payload, result, fingerprint, expired_at FROM workflow.workflow_invocations WHERE run_id = $1',
        [runId]
      );
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toEqual({
          payload: null,
          result: null,
          fingerprint: null,
          expired_at: expect.any(Date),
        });
      expect(await transport.pending(runId)).toEqual([]);
    });

    it('does not deduplicate intentionally separate resumes with identical payloads', async () => {
      const runId = `wrun_${ulid()}`;
      const hookId = `hook_${ulid()}`;
      const token = randomUUID();
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'postgres',
          workflowName: 'oneHook',
          input: await dehydrateWorkflowArguments([token], runId, undefined),
        },
      });
      await world.events.create(runId, { eventType: 'run_started' });
      await world.events.create(runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      const input = {
        type: 'hook_resume',
        version: 1,
        hookId,
        token,
        payload: new Uint8Array([1, 2]),
      };
      await handleInvocation(world, runId, 'first', input);
      await handleInvocation(world, runId, 'second', input);
      const received = (await world.events.list({ runId })).data.filter(
        (event) => event.eventType === 'hook_received'
      );
      expect(received.map((event) => event.resumeId)).toEqual([
        'first',
        'second',
      ]);
      await world.events.create(runId, { eventType: 'run_cancelled' });
    });

    it('serializes late mailbox insertion/response against a purge holding the run lock', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId, { $retention: '0' });
      const id = randomUUID();
      await expect(
        transport.invoke(
          runId,
          { secret: 'input' },
          { idempotencyKey: id, timeoutMs: 10 },
          async () => {}
        )
      ).rejects.toMatchObject({ status: 408 });
      const lock = await pool.connect();
      await lock.query('BEGIN');
      await lock.query(
        'SELECT id FROM workflow.workflow_runs WHERE id = $1 FOR UPDATE',
        [runId]
      );
      const response = transport.respond(runId, id, { secret: 'result' });
      const insert = transport.invoke(
        runId,
        { secret: 'late input' },
        undefined,
        async () => {}
      );
      const rejected = expect(insert).rejects.toMatchObject({ status: 410 });
      try {
        // Same lock/write ordering as purgeRunUserData's transaction.
        await lock.query(
          "UPDATE workflow.workflow_runs SET status = 'cancelled', expired_at = now() WHERE id = $1",
          [runId]
        );
        await lock.query(
          'UPDATE workflow.workflow_invocations SET payload = NULL, result = NULL, fingerprint = NULL, expired_at = now() WHERE run_id = $1',
          [runId]
        );
        await lock.query('COMMIT');
      } finally {
        await lock.query('ROLLBACK').catch(() => {});
        lock.release();
      }
      await response;
      await rejected;
      const { rows } = await pool.query(
        'SELECT payload, result FROM workflow.workflow_invocations WHERE run_id = $1',
        [runId]
      );
      expect(rows).toEqual([{ payload: null, result: null }]);
    });

    it('backfills zero-retention mailbox data left by an earlier preview', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId, { $retention: '0' });
      await pool.query(
        "UPDATE workflow.workflow_runs SET status = 'completed' WHERE id = $1",
        [runId]
      );
      await pool.query(
        `INSERT INTO workflow.workflow_invocations(run_id, request_id, payload, result, fingerprint)
        VALUES ($1, 'old', $2, $2, 'old-hash')`,
        [runId, Buffer.from([1])]
      );
      const migration = await readFile(
        new URL(
          '../src/drizzle/migrations/0021_invocation_identity_retention.sql',
          import.meta.url
        ),
        'utf8'
      );
      const backfill = migration
        .split('--> statement-breakpoint')
        .find((statement) => statement.trimStart().startsWith('UPDATE'));
      if (!backfill) throw new Error('Missing migration backfill');
      await pool.query(backfill);
      const { rows } = await pool.query(
        'SELECT payload, result, fingerprint, expired_at FROM workflow.workflow_invocations WHERE run_id = $1',
        [runId]
      );
      expect(rows).toEqual([
        {
          payload: null,
          result: null,
          fingerprint: null,
          expired_at: expect.any(Date),
        },
      ]);
    });

    it('bounds listener connections and mailbox growth under concurrent invokes', async () => {
      const name = `soak-${randomUUID()}`;
      const producerPool = new Pool({
        connectionString: container.getConnectionUri(),
        application_name: name,
        max: 8,
      });
      const producer = createQueue(
        {
          pool: producerPool,
          enableInvoke: true,
          queueConcurrency: 2,
          applicationManagedShutdown: true,
        },
        producerPool
      );
      const reads = vi.spyOn(producerPool, 'query');
      const runIds: string[] = [];
      let calls = 0;
      const listenerCount = async () =>
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
            [`${name}:invocations`]
          )
        ).rows[0].n;
      try {
        await producer.start();
        expect(await listenerCount()).toBe(0);
        for (let wave = 0; wave < 3; wave++) {
          const runs = await Promise.all(
            Array.from({ length: 12 }, async (_, index) => {
              const tokens = [randomUUID(), randomUUID()];
              const runId = await start('twoHooks', [tokens]);
              runIds.push(runId);
              const hooks = await Promise.all(tokens.map(hook));
              await Promise.all(
                hooks.map(async (target, slot) => {
                  if (!target || !producer.invoke)
                    throw new Error('Missing invoke fixture');
                  const payload = await dehydrateStepReturnValue(
                    `${wave}:${index}:${slot}`,
                    runId,
                    undefined,
                    []
                  );
                  calls++;
                  await expect(
                    producer.invoke(runId, {
                      type: 'hook_resume',
                      version: 1,
                      hookId: target.hookId,
                      token: target.token,
                      payload,
                    })
                  ).resolves.toEqual({ status: 'accepted' });
                })
              );
              return runId;
            })
          );
          await Promise.all(
            runs.map((runId) =>
              until(
                () => world.runs.get(runId),
                (run) => run.status === 'completed'
              )
            )
          );
        }
        expect(await listenerCount()).toBe(1);
        const { rows } = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM workflow.workflow_invocations WHERE run_id = ANY($1::varchar[]) AND responded_at IS NOT NULL',
          [runIds]
        );
        expect(rows[0].n).toBe(calls);
        await until(
          async () =>
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE queue_name = ANY($1::text[])',
                [runIds.map((id) => `workflow_flows:${id}:executor`)]
              )
            ).rows[0].n,
          (n) => n === 0
        );
        const resultReads = reads.mock.calls.filter(
          ([query]) =>
            typeof query === 'string' && query.startsWith('SELECT result,')
        ).length;
        console.info('Invocation concurrency fixture', {
          calls,
          resultReads,
          listenerConnections: 1,
          completedRows: rows[0].n,
        });
      } finally {
        reads.mockRestore();
        await producer.close();
        await producerPool.end();
      }
      expect(await listenerCount()).toBe(0);
    }, 60_000);

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
      await transport.respond(runId, delivery.value.id, { status: 'accepted' });
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

    it('notifies input and result observers only after their writes commit', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId);
      const id = randomUUID();
      const observer = createInvocationNotifications(pool);
      const inputWatch = observer.watch(
        INVOCATION_INPUT_TOPIC,
        invocationNotificationKey(runId)
      );
      const resultWatch = observer.watch(
        INVOCATION_RESULT_TOPIC,
        invocationNotificationKey(runId, id)
      );
      const entered = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();
      await until(
        async () => inputWatch.revision,
        (revision) => revision > 0
      );
      const inputRevision = inputWatch.revision;
      const resultRevision = resultWatch.revision;
      const sent = transport.invoke(
        runId,
        { value: 1 },
        { idempotencyKey: id, timeoutMs: 3_000 },
        async (client) => {
          await client.query(
            'SELECT graphile_worker.add_job($1, $2::json, queue_name => $3)',
            ['transport_test', JSON.stringify({ runId }), `transport:${runId}`]
          );
          entered.resolve();
          await commit.promise;
        }
      );
      // Observe errors immediately even if a failed assertion takes us to cleanup.
      void sent.catch(() => {});
      let feed: ReturnType<typeof transport.feed> | undefined;
      try {
        await entered.promise;
        expect(await transport.pending(runId)).toEqual([]);
        expect(inputWatch.revision).toBe(inputRevision);
        commit.resolve();
        // Revisions change on a real notification, never on the fallback timer.
        await until(
          async () => inputWatch.revision,
          (revision) => revision > inputRevision
        );
        const rows = await transport.pending(runId);
        expect(rows).toHaveLength(1);
        feed = transport.feed(runId, rows);
        const input = await feed.next();
        if (input.done) throw new Error('Missing input');
        expect(resultWatch.revision).toBe(resultRevision);
        await transport.respond(runId, input.value.id, { status: 'accepted' });
        await until(
          async () => resultWatch.revision,
          (revision) => revision > resultRevision
        );
        await expect(sent).resolves.toEqual({ status: 'accepted' });
      } finally {
        commit.resolve();
        await feed?.return?.();
        inputWatch.dispose();
        resultWatch.dispose();
        await observer.close();
        await sent.catch(() => {});
      }
    });

    it('reconnects a terminated real LISTEN client and receives later notifications', async () => {
      const name = `notify-${randomUUID()}`;
      const listenerPool = new Pool({
        connectionString: container.getConnectionUri(),
        application_name: name,
      });
      const observer = createInvocationNotifications(listenerPool);
      const key = invocationNotificationKey('reconnect');
      const watch = observer.watch(INVOCATION_INPUT_TOPIC, key);
      const signal = new AbortController().signal;
      const listenerPid = async () =>
        (
          await pool.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state = $2',
            [`${name}:invocations`, 'idle']
          )
        ).rows[0]?.pid;
      try {
        await until(
          async () => watch.revision,
          (revision) => revision > 0
        );
        const firstPid = await until(listenerPid, (pid) => pid !== undefined);
        const beforeDisconnect = watch.revision;
        await pool.query('SELECT pg_terminate_backend($1)', [firstPid]);
        await until(
          async () => watch.revision,
          (revision) => revision > beforeDisconnect
        );
        // Normal consumers reread on disconnect, then use the slow fallback
        // while reconnect is backed off, then wait/read again.
        await watch.wait(watch.revision, 1_000, signal);
        const reconnected = watch.wait(watch.revision, 5_000, signal);
        const secondPid = await until(
          listenerPid,
          (pid) => pid !== undefined && pid !== firstPid
        );
        await reconnected;
        expect(secondPid).not.toBe(firstPid);
        const beforeNotify = watch.revision;
        await pool.query('SELECT pg_notify($1, $2)', [
          INVOCATION_INPUT_TOPIC,
          key,
        ]);
        await until(
          async () => watch.revision,
          (revision) => revision > beforeNotify
        );
      } finally {
        watch.dispose();
        await observer.close();
        await listenerPool.end();
      }
      expect(await listenerPid()).toBeUndefined();
    });

    it('finds a stored result through the slow fallback when its notification is missing', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId);
      const id = randomUUID();
      const sent = transport.invoke(
        runId,
        {},
        { idempotencyKey: id, timeoutMs: 3_000 },
        async () => {}
      );
      void sent.catch(() => {});
      await until(
        () => transport.pending(runId),
        (rows) => rows.length === 1
      );
      // Deliberately omit pg_notify to simulate a lost signal. The result
      // table, not notification delivery, decides what invoke returns.
      await pool.query(
        'UPDATE workflow.workflow_invocations SET result = $3, responded_at = now() WHERE run_id = $1 AND request_id = $2',
        [runId, id, Buffer.from(encode({ status: 'accepted' }))]
      );
      await expect(sent).resolves.toEqual({ status: 'accepted' });
    });

    it('rolls back the input when wake enqueue fails', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId);
      await expect(
        transport.invoke(runId, {}, undefined, async () => {
          throw new Error('enqueue failed');
        })
      ).rejects.toThrow('enqueue failed');
      expect(await transport.pending(runId)).toEqual([]);
    });

    it('leaves timed-out input pending and cancels a blocked feed read on return', async () => {
      const runId = randomUUID();
      await seedTransportRun(runId);
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
