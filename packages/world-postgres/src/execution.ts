import { createHash, randomUUID } from 'node:crypto';
import {
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import {
  type CreateEventRequest,
  EXECUTION_PROFILE,
  ExecutionInputSchema,
  type ExecutionStorage,
  executionEventResult,
  getQueueTopicPrefix,
  mintedSpecVersion,
  projectExecutionSnapshot,
  type RunCreatedEventRequest,
  resolveQueueNamespace,
  type World,
} from '@workflow/world';
import { Pool } from 'pg';
import type { PostgresWorldConfig } from './config.js';
import { ExecutionSessions } from './execution-sessions.js';
import { ExecutionStore } from './execution-store.js';
import { createQueue } from './queue.js';

export type ExecutionWorldConfig = PostgresWorldConfig & {
  submitTimeoutMs?: number;
};

/** Standalone opt-in, root-only reference execution World. */
export function createWorld(
  config: ExecutionWorldConfig = {
    connectionString:
      process.env.WORKFLOW_POSTGRES_URL ??
      process.env.DATABASE_URL ??
      'postgres://world:world@localhost:5432/world',
    applicationManagedShutdown:
      process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN === '1',
    queueConcurrency:
      Number(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY) || 50,
  }
): World & { start(): Promise<void> } {
  const pool =
    config.pool ??
    new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
    });
  if (!config.pool)
    pool.on('error', (error) =>
      console.error('Idle execution storage connection failed:', error.message)
    );
  const namespace = resolveQueueNamespace(config.namespace) ?? '';
  const store = new ExecutionStore(pool, namespace);
  let initialized: Promise<void> | undefined;
  const setup = () => (initialized ??= store.setup());
  const queue = createQueue(
    {
      ...config,
      jobPrefix:
        config.jobPrefix ??
        `execution_${createHash('sha256').update(namespace).digest('hex').slice(0, 16)}_`,
    },
    pool,
    { migrateLegacyJobs: false, serializeWorkflowRuns: false }
  );
  // Ownership connections must not exhaust the pool needed by journal commits.
  const sessions = new ExecutionSessions(
    store,
    new Pool({ ...pool.options, password: pool.options.password })
  );
  let closing: Promise<void> | undefined;
  const read = async (id: string) => {
    await setup();
    const snapshot = await store.snapshot(id);
    if (!snapshot) throw new WorkflowRunNotFoundError(id);
    return snapshot;
  };
  const wake = async (id: string) => {
    const run = projectExecutionSnapshot(await read(id)).run;
    await world.queue(
      `${getQueueTopicPrefix('workflow', resolveQueueNamespace(config.namespace))}${run.workflowName}`,
      { runId: id }
    );
  };
  const execution: ExecutionStorage = {
    profile: EXECUTION_PROFILE,
    async create(id, event) {
      await setup();
      return store.create(id, event);
    },
    acquire: read,
    async exchange(request) {
      await setup();
      return store.exchange(request, sessions.ownerId(request.runId));
    },
    async receipt(id, op) {
      await setup();
      return store.receipt(id, op);
    },
    async quarantine(id, fault) {
      await setup();
      await store.quarantine(id, fault);
    },
    async submit(id, event, params) {
      const operationId = params?.resumeId ?? randomUUID();
      const input = ExecutionInputSchema.parse({ operationId, event });
      await setup();
      await store.stage(id, input);
      const existing = await store.receipt(id, operationId);
      if (existing)
        return executionEventResult(
          await read(id),
          existing.events[existing.events.length - 1]
        ) as never;
      await wake(id);
      const until = Date.now() + (config.submitTimeoutMs ?? 60_000);
      while (Date.now() < until) {
        const receipt = await store.receipt(id, operationId);
        if (receipt)
          return executionEventResult(
            await read(id),
            receipt.events[receipt.events.length - 1]
          ) as never;
        if (
          ['completed', 'failed', 'cancelled'].includes(
            projectExecutionSnapshot(await read(id)).run.status
          )
        ) {
          // The input may have committed between the first receipt read and
          // this terminal-state read. Recheck before rejecting its outcome.
          const committed = await store.receipt(id, operationId);
          if (committed)
            return executionEventResult(
              await read(id),
              committed.events[committed.events.length - 1]
            ) as never;
          throw new RunExpiredError(
            'Execution ended before submission committed'
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Submission outcome unknown: ${operationId}`);
    },
    createHandler(factory, options) {
      return queue.createQueueHandler(
        getQueueTopicPrefix(
          'workflow',
          resolveQueueNamespace(options?.namespace)
        ),
        async (payload) => {
          if (
            !payload ||
            typeof payload !== 'object' ||
            !('runId' in payload) ||
            typeof payload.runId !== 'string'
          )
            throw new Error('Execution delivery requires runId');
          const id = payload.runId;
          await setup();
          if ('stepId' in payload && payload.stepId)
            throw new Error(
              'Execution World does not accept remote step deliveries'
            );
          if (
            'executionInput' in payload &&
            payload.executionInput !== undefined
          )
            await store.stage(
              id,
              ExecutionInputSchema.parse(payload.executionInput)
            );
          await sessions.run(id, factory);
        }
      );
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Unsupported by single-owner Postgres reference World');
  };
  const world: World & { start(): Promise<void> } = {
    ...queue,
    specVersion: mintedSpecVersion(),
    execution,
    runs: {
      get: (async (id) =>
        projectExecutionSnapshot(await read(id)).run) as World['runs']['get'],
      list: unsupported,
    },
    events: {
      create: (async (
        id: string | null,
        event: CreateEventRequest | RunCreatedEventRequest,
        params?: Parameters<ExecutionStorage['submit']>[2]
      ) => {
        if (!id)
          throw new Error('Execution requires a client-generated run ID');
        if (event.eventType === 'run_created') {
          const s = await execution.create(id, event);
          return executionEventResult(s, s.events[0]);
        }
        return execution.submit(id, event, params);
      }) as World['events']['create'],
      get: async (id, eventId) => {
        const e = (await read(id)).events.find((e) => e.eventId === eventId);
        if (!e) throw new Error('Event not found');
        return e;
      },
      list: async ({ runId }) => ({
        data: (await read(runId)).events,
        cursor: null,
        hasMore: false,
      }),
      listByCorrelationId: async ({ runId, correlationId }) => ({
        data: (await read(runId)).events.filter(
          (e) => e.correlationId === correlationId
        ),
        cursor: null,
        hasMore: false,
      }),
    },
    steps: {
      get: (async (id, stepId) => {
        const step = projectExecutionSnapshot(await read(id)).steps.get(stepId);
        if (!step) throw new Error('Step not found');
        return step;
      }) as World['steps']['get'],
      list: (async ({ runId }) => ({
        data: [...projectExecutionSnapshot(await read(runId)).steps.values()],
        cursor: null,
        hasMore: false,
      })) as World['steps']['list'],
    },
    hooks: {
      get: unsupported,
      async getByToken(token) {
        await setup();
        const binding = await pool.query(
          'SELECT run_id,hook_id FROM workflow_execution.hooks WHERE namespace=$1 AND token=$2',
          [namespace, token]
        );
        if (!binding.rows[0]) throw new HookNotFoundError(token);
        const hook = projectExecutionSnapshot(
          await read(binding.rows[0].run_id)
        ).hooks.get(binding.rows[0].hook_id);
        if (!hook) throw new HookNotFoundError(token);
        return hook;
      },
      list: async ({ runId }) => {
        if (!runId) throw new Error('Run ID required');
        return {
          data: [...projectExecutionSnapshot(await read(runId)).hooks.values()],
          cursor: null,
          hasMore: false,
        };
      },
    },
    streams: {
      write: unsupported,
      close: unsupported,
      get: unsupported,
      list: unsupported,
      getChunks: unsupported,
      getInfo: unsupported,
    },
    async start() {
      await setup();
      await queue.start();
      const rows = await pool.query(
        'SELECT run_id FROM workflow_execution.runs WHERE namespace=$1 AND fault IS NULL',
        [namespace]
      );
      for (const row of rows.rows) {
        const run = projectExecutionSnapshot(await read(row.run_id)).run;
        if (run.status === 'pending' || run.status === 'running')
          await wake(row.run_id);
      }
    },
    async close() {
      closing ??= (async () => {
        await queue.close();
        await sessions.close();
        if (!config.pool) await pool.end();
      })();
      await closing;
    },
  };
  return world;
}
