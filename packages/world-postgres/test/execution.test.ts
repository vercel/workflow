import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type ExecutionExchange,
  ExecutionInvariantError,
  type ExecutionSession,
  type RunCreatedEventRequest,
} from '@workflow/world';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { registerStepFunction } from '../../core/src/private.js';
import { executionWorkflowHandler } from '../../core/src/runtime/execution.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../../core/src/serialization.js';
import { createWorld } from '../src/execution.js';
import { ExecutionSessions } from '../src/execution-sessions.js';
import { ExecutionStore } from '../src/execution-store.js';

const creation: RunCreatedEventRequest = {
  eventType: 'run_created',
  specVersion: 7,
  eventData: {
    deploymentId: 'postgres',
    workflowName: 'workflow//test//main',
    input: new Uint8Array([1, 2, 3]),
  },
};

describe('Postgres execution transactions and ownership', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let store: ExecutionStore;
  const namespace = 'test';
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    store = new ExecutionStore(pool, namespace);
    await Promise.all([
      store.setup(),
      new ExecutionStore(pool, namespace).setup(),
    ]);
  }, 120_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE workflow_execution.runs CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function create(runId = 'wrun_test') {
    await store.create(runId, creation);
    // Store-only tests establish a grant explicitly; session tests below exercise
    // the real acquisition lock and its separate pool.
    const connection = await pool.connect();
    try {
      await store.claim(connection, runId, 'owner');
    } finally {
      connection.release();
    }
  }
  const request = (
    events: ExecutionExchange['events'],
    options: Partial<ExecutionExchange> = {}
  ): ExecutionExchange => ({
    runId: 'wrun_test',
    deploymentId: 'postgres',
    activationId: 'activation',
    operationId: randomUUID(),
    expectedHead: 1,
    events,
    ...options,
  });
  const started = { eventType: 'run_started' as const, specVersion: 7 };

  it('deduplicates exact creation with binary input and rejects changed creation', async () => {
    const first = await store.create('wrun_test', creation);
    expect(await store.create('wrun_test', creation)).toEqual(first);
    await expect(
      store.create('wrun_test', {
        ...creation,
        eventData: { ...creation.eventData, workflowName: 'other' },
      })
    ).rejects.toThrow('different creation');
    await expect(store.snapshot('wrun_test')).rejects.toThrow(
      'different creation'
    );
  });
  it('commits dense multi-event batches and returns the same retry receipt', async () => {
    await create();
    const append = request([
      started,
      {
        eventType: 'wait_created',
        specVersion: 7,
        correlationId: 'wait_1',
        eventData: { resumeAt: new Date(1234) },
      },
    ]);
    const first = await store.exchange(append, 'owner');
    expect(first.head).toBe(3);
    expect(await store.exchange(append, 'owner')).toEqual(first);
    expect(await store.receipt('wrun_test', append.operationId)).toEqual(first);
    expect(
      (await store.snapshot('wrun_test'))?.events.map((e) => e.eventId)
    ).toEqual([1, 2, 3].map((n) => `evnt_${String(n).padStart(26, '0')}`));
  });
  it('atomically quarantines the losing head race without slot walking', async () => {
    await create();
    const results = await Promise.allSettled([
      store.exchange(request([started]), 'owner'),
      store.exchange(request([started]), 'owner'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const row = await pool.query(
      'SELECT head,fault FROM workflow_execution.runs'
    );
    expect(row.rows[0].head).toBe('2');
    expect(row.rows[0].fault.message).toContain('Expected head');
    await expect(store.snapshot('wrun_test')).rejects.toThrow(
      ExecutionInvariantError
    );
  });
  it('rolls back hook effects when a later event in the batch is invalid', async () => {
    await create();
    await expect(
      store.exchange(
        request([
          {
            eventType: 'hook_created',
            specVersion: 7,
            correlationId: 'hook_1',
            eventData: { token: 'token' },
          },
          {
            eventType: 'wait_completed',
            specVersion: 7,
            correlationId: 'wait_missing',
            eventData: { resumeAt: new Date() },
          },
        ]),
        'owner'
      )
    ).rejects.toThrow('missing wait');
    expect(
      (await pool.query('SELECT * FROM workflow_execution.hooks')).rowCount
    ).toBe(0);
    expect(
      (await pool.query('SELECT * FROM workflow_execution.receipts')).rowCount
    ).toBe(0);
    expect(
      (await pool.query('SELECT head,fault FROM workflow_execution.runs'))
        .rows[0]
    ).toMatchObject({
      head: '1',
      fault: { code: 'EXECUTION_INVARIANT_VIOLATION' },
    });
  });
  it('journals token conflicts and allows reuse after disposal', async () => {
    await create();
    await create('wrun_other');
    const hook = {
      eventType: 'hook_created' as const,
      specVersion: 7,
      correlationId: 'hook_1',
      eventData: { token: 'token' },
    };
    await store.exchange(request([hook]), 'owner');
    const conflict = await store.exchange(
      request([hook], { runId: 'wrun_other' }),
      'owner'
    );
    expect(conflict.events[0].eventType).toBe('hook_conflict');
    await store.exchange(
      request(
        [
          {
            eventType: 'hook_disposed',
            specVersion: 7,
            correlationId: 'hook_1',
          },
        ],
        { expectedHead: 2 }
      ),
      'owner'
    );
    const acquired = await store.exchange(
      request([hook], { runId: 'wrun_other', expectedHead: 2 }),
      'owner'
    );
    expect(acquired.events[0].eventType).toBe('hook_created');
  });
  it('rejects changed operation content and stale ownership even at the right head', async () => {
    await create();
    const append = request([started]);
    await store.exchange(append, 'owner');
    await expect(
      store.exchange(
        { ...append, events: [{ eventType: 'run_cancelled', specVersion: 7 }] },
        'owner'
      )
    ).rejects.toThrow('different content');
    await create('wrun_other');
    await expect(
      store.exchange(request([started], { runId: 'wrun_other' }), 'obsolete')
    ).rejects.toThrow('grant');
  });
  it('persists input without claiming journal acknowledgement, then deduplicates it', async () => {
    await create();
    const input = {
      operationId: 'input_1',
      event: {
        eventType: 'attr_set' as const,
        specVersion: 7,
        eventData: {
          writer: { type: 'workflow' as const },
          changes: [{ key: 'progress', value: 'ready' }],
        },
      },
    };
    await store.stage('wrun_test', input);
    await store.stage('wrun_test', input);
    expect(await store.receipt('wrun_test', input.operationId)).toBeUndefined();
    expect(await store.pending('wrun_test')).toEqual([input]);
    await store.exchange(
      request([input.event], { operationId: input.operationId }),
      'owner'
    );
    expect(await store.pending('wrun_test')).toEqual([]);
    await expect(
      store.stage('wrun_test', {
        ...input,
        event: { eventType: 'run_cancelled', specVersion: 7 },
      })
    ).rejects.toThrow('different input');
  });
  it('keeps run and token namespaces independent', async () => {
    const other = new ExecutionStore(pool, 'other');
    await store.create('wrun_test', creation);
    await other.create('wrun_test', {
      ...creation,
      eventData: { ...creation.eventData, workflowName: 'independent' },
    });
    expect((await other.snapshot('wrun_test'))?.events[0]).not.toEqual(
      (await store.snapshot('wrun_test'))?.events[0]
    );
  });

  it('quarantines a snapshot that disagrees with the stored head', async () => {
    await create();
    await pool.query('UPDATE workflow_execution.runs SET head=2');
    await expect(store.snapshot('wrun_test')).rejects.toThrow(
      'disagrees with storage'
    );
    expect(
      (await pool.query('SELECT fault FROM workflow_execution.runs')).rows[0]
        .fault.code
    ).toBe('EXECUTION_INVARIANT_VIOLATION');
  });

  it('excludes another host, admits inputs during a blocked body, and releases cleanly', async () => {
    await store.create('wrun_test', creation);
    const first = new ExecutionSessions(
      store,
      new Pool({ ...pool.options, max: 1 })
    );
    const second = new ExecutionSessions(
      new ExecutionStore(pool, namespace),
      new Pool({ ...pool.options, max: 1 })
    );
    const gate = Promise.withResolvers<void>();
    const began = Promise.withResolvers<void>();
    let head = 1;
    const factory = vi.fn(
      (): ExecutionSession => ({
        async receive(input) {
          began.resolve();
          if (input) {
            const committed = await store.exchange(
              request([input.event], {
                operationId: input.operationId,
                expectedHead: head,
              }),
              first.ownerId('wrun_test')
            );
            head = committed.head;
          }
          await gate.promise;
        },
        async invalidate(error) {
          throw error;
        },
      })
    );
    const running = first.run('wrun_test', factory);
    try {
      await began.promise;
      await expect(second.run('wrun_test', factory)).rejects.toThrow('busy');
      await new ExecutionStore(pool, namespace).stage('wrun_test', {
        operationId: 'external',
        event: {
          eventType: 'attr_set',
          specVersion: 7,
          eventData: {
            writer: { type: 'workflow' },
            changes: [{ key: 'progress', value: 'body-pending' }],
          },
        },
      });
      await expect
        .poll(async () => (await store.receipt('wrun_test', 'external'))?.head)
        .toBe(2);
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await running;
    }
    const replacement = vi.fn(
      (): ExecutionSession => ({
        receive: async () => {},
        invalidate: async (error) => {
          throw error;
        },
      })
    );
    await second.run('wrun_test', replacement);
    expect(replacement).toHaveBeenCalledOnce();
    await first.close();
    await second.close();
    expect(
      (await pool.query('SELECT owner_id FROM workflow_execution.runs')).rows[0]
        .owner_id
    ).toBeNull();
  });
  it('quarantines unclean owner loss before running replacement code', async () => {
    await store.create('wrun_test', creation);
    const abandoned = await pool.connect();
    await abandoned.query('SELECT pg_advisory_lock(hashtextextended($1,1))', [
      JSON.stringify([namespace, 'wrun_test']),
    ]);
    await store.claim(abandoned, 'wrun_test', 'lost');
    abandoned.release(true);
    const replacement = new ExecutionSessions(
      store,
      new Pool({ ...pool.options, max: 1 })
    );
    const factory = vi.fn();
    await expect(replacement.run('wrun_test', factory)).rejects.toThrow(
      'disappeared'
    );
    expect(factory).not.toHaveBeenCalled();
    await expect(store.snapshot('wrun_test')).rejects.toThrow('disappeared');
    await replacement.close();
  });

  it('runs the real workflow VM and inline steps through the Postgres World', async () => {
    const world = createWorld({ pool, applicationManagedShutdown: true });
    const runId = 'wrun_real';
    const bodies: number[] = [];
    const stepName = `step//test//${randomUUID()}`;
    registerStepFunction(stepName, async (value: number) => {
      const events = await world.events.list({ runId });
      expect(events.data.at(-1)?.eventType).toBe('step_started');
      bodies.push(value);
      return value + 1;
    });
    const code = `const increment = globalThis[Symbol.for('WORKFLOW_USE_STEP')](${JSON.stringify(stepName)});
      async function main(value) { return await increment(await increment(value)); }
      globalThis.__private_workflows = new Map([['main', main]]);`;
    const ops: Promise<unknown>[] = [];
    const input = await dehydrateWorkflowArguments([40], runId, undefined, ops);
    await Promise.all(ops);
    await world.execution!.create(runId, {
      ...creation,
      eventData: { deploymentId: 'postgres', workflowName: 'main', input },
    });
    const handler = executionWorkflowHandler(code, world);
    const delivery = () =>
      handler(
        new Request('http://local/execute', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vqs-queue-name': '__wkf_workflow_main',
            'x-vqs-message-id': 'msg_00000000000000000000000001',
            'x-vqs-message-attempt': '1',
          },
          body: JSON.stringify({ runId }),
        })
      );
    try {
      const response = await delivery();
      expect(await response.text()).toContain('"ok":true');
      expect(response.status).toBe(200);
      const run = await world.runs.get(runId);
      expect(run.status).toBe('completed');
      if (run.status !== 'completed') throw new Error('Run did not complete');
      expect(
        await hydrateWorkflowReturnValue(run.output, runId, undefined, [])
      ).toBe(42);
      expect(bodies).toEqual([40, 41]);
      expect((await delivery()).status).toBe(200);
      expect(bodies).toEqual([40, 41]);
    } finally {
      await world.close?.();
    }
  });

  it('acknowledges a public submission through Graphile only after journaling, while a real body is blocked', async () => {
    const world = createWorld({
      pool,
      applicationManagedShutdown: true,
      queueConcurrency: 4,
      submitTimeoutMs: 5000,
    });
    const runId = 'wrun_ingress';
    const gate = Promise.withResolvers<void>();
    const began = Promise.withResolvers<void>();
    const stepName = `step//test//${randomUUID()}`;
    registerStepFunction(stepName, async () => {
      began.resolve();
      await gate.promise;
      return 42;
    });
    const code = `const blocked = globalThis[Symbol.for('WORKFLOW_USE_STEP')](${JSON.stringify(stepName)});
      const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
      async function main() { return await Promise.all([blocked(), createHook({token:'public-hook'})]); }
      globalThis.__private_workflows = new Map([['main',main]]);`;
    const handler = executionWorkflowHandler(code, world);
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const response = await handler(
          new Request('http://local/execute', {
            method: 'POST',
            headers: req.headers as Record<string, string>,
            body: Buffer.concat(chunks),
          })
        );
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
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
      throw new Error('No server address');
    const previousUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}/.well-known/workflow/v1`;
    try {
      const input = await dehydrateWorkflowArguments([], runId, undefined, []);
      await world.execution!.create(runId, {
        ...creation,
        eventData: { deploymentId: 'postgres', workflowName: 'main', input },
      });
      await world.queue('__wkf_workflow_main', { runId });
      await Promise.race([
        began.promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Body did not start')),
            5000
          ).unref()
        ),
      ]);
      const hook = await world.hooks.getByToken('public-hook');
      const event = {
        eventType: 'hook_received' as const,
        specVersion: 7,
        correlationId: hook.hookId,
        eventData: {
          payload: await dehydrateStepReturnValue(
            'received',
            runId,
            undefined,
            []
          ),
        },
      };
      const result = await world.execution!.submit(runId, event, {
        resumeId: 'public_input',
      });
      expect(result.event.eventType).toBe('hook_received');
      expect(
        (await world.execution!.receipt(runId, 'public_input'))?.events[0]
      ).toEqual(result.event);
      expect((await world.runs.get(runId)).status).toBe('running');
      expect(
        await world.execution!.submit(runId, event, {
          resumeId: 'public_input',
        })
      ).toEqual(result);
      gate.resolve();
      await expect
        .poll(async () => (await world.runs.get(runId)).status, {
          timeout: 5000,
        })
        .toBe('completed');
    } finally {
      gate.resolve();
      await world.close?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      if (previousUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
      else process.env.WORKFLOW_LOCAL_BASE_URL = previousUrl;
    }
  }, 15000);

  it('cancels during a real inline body without committing its late result or quarantining', async () => {
    const world = createWorld({ pool, applicationManagedShutdown: true });
    const runId = 'wrun_cancel';
    const gate = Promise.withResolvers<void>();
    const began = Promise.withResolvers<void>();
    const stepName = `step//test//${randomUUID()}`;
    registerStepFunction(stepName, async () => {
      began.resolve();
      await gate.promise;
      return 42;
    });
    const code = `const blocked = globalThis[Symbol.for('WORKFLOW_USE_STEP')](${JSON.stringify(stepName)});
      async function main() { return await blocked(); }
      globalThis.__private_workflows = new Map([['main',main]]);`;
    await world.execution!.create(runId, {
      ...creation,
      eventData: {
        deploymentId: 'postgres',
        workflowName: 'main',
        input: await dehydrateWorkflowArguments([], runId, undefined, []),
      },
    });
    const handler = executionWorkflowHandler(code, world);
    const deliver = (extra = {}) =>
      handler(
        new Request('http://local/execute', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vqs-queue-name': '__wkf_workflow_main',
            'x-vqs-message-id': 'msg_00000000000000000000000001',
            'x-vqs-message-attempt': '1',
          },
          body: JSON.stringify({ runId, ...extra }),
        })
      );
    const running = deliver();
    await began.promise;
    const cancelling = deliver({
      executionInput: {
        operationId: 'cancel',
        event: { eventType: 'run_cancelled', specVersion: 7 },
      },
    });
    try {
      await expect
        .poll(async () => (await world.runs.get(runId)).status)
        .toBe('cancelled');
    } finally {
      gate.resolve();
    }
    try {
      const responses = await Promise.all([running, cancelling]);
      for (const response of responses)
        expect(await response.text()).toContain('"ok":true');
      expect((await world.runs.get(runId)).status).toBe('cancelled');
      expect((await world.events.list({ runId })).data.at(-1)?.eventType).toBe(
        'run_cancelled'
      );
    } finally {
      await world.close?.();
    }
  });
});
