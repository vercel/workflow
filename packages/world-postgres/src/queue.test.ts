import { getEventListeners } from 'node:events';
import { createServer, type Server } from 'node:http';
import { JsonTransport } from '@vercel/queue';
import { setWorkflowBasePath } from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  IN_PROCESS_QUEUE_HANDLER,
  type InProcessDelivery,
  MessageId,
  parseQueueName,
  type Queue,
  type QueuePayload,
  type QueuePrefix,
  type QueueRouteHandler,
  queueDeliveryHeaders,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type ValidQueueName,
} from '@workflow/world';
import {
  makeWorkerUtils,
  type Runner,
  run,
  type WorkerUtils,
} from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageData } from './message.js';
import {
  createQueue,
  DEFAULT_DELIVERY_BODY_TIMEOUT_MS,
  DEFAULT_DELIVERY_HEADERS_TIMEOUT_MS,
  getDeliveryTimeouts,
} from './queue.js';

const transport = new JsonTransport();
const createdQueues: Array<ReturnType<typeof createQueue>> = [];
const createdServers: Server[] = [];
const invocationTransport = vi.hoisted(() => ({
  pending: vi.fn(),
  feed: vi.fn(),
  close: vi.fn(),
  invoke: vi.fn(),
  respondOutcome: vi.fn(),
}));
vi.mock('./invocations.js', () => ({
  createInvocations: () => invocationTransport,
}));

vi.mock('graphile-worker', () => ({
  Logger: class Logger {
    constructor(_: unknown) {}
  },
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

describe('postgres queue http execution', () => {
  const workerUtilsMock = {
    addJob: vi.fn(),
    migrate: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const runnerMock = {
    stop: vi.fn(),
    promise: Promise.resolve(),
  };
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    invocationTransport.pending.mockResolvedValue([]);
    invocationTransport.close.mockResolvedValue(undefined);
    invocationTransport.respondOutcome.mockResolvedValue(undefined);
    pool.query.mockResolvedValue({ rows: [{ exists: false }] });

    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(runnerMock as unknown as Runner);
  });

  afterEach(async () => {
    await Promise.all(createdQueues.splice(0).map((queue) => queue.close()));
    await Promise.all(
      createdServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
            server.closeAllConnections();
          })
      )
    );
    vi.useRealTimers();
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    delete process.env.PORT;
    delete process.env.WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS;
    delete process.env.WORKFLOW_POSTGRES_BODY_TIMEOUT_MS;
    delete process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS;
    setWorkflowBasePath(undefined);
  });

  it('places no deadline on a delivery unless the operator sets one', () => {
    expect(getDeliveryTimeouts()).toEqual({
      headersTimeoutMs: DEFAULT_DELIVERY_HEADERS_TIMEOUT_MS,
      bodyTimeoutMs: DEFAULT_DELIVERY_BODY_TIMEOUT_MS,
    });
    expect(DEFAULT_DELIVERY_HEADERS_TIMEOUT_MS).toBe(0);
    expect(DEFAULT_DELIVERY_BODY_TIMEOUT_MS).toBe(0);

    process.env.WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS = '1500';
    process.env.WORKFLOW_POSTGRES_BODY_TIMEOUT_MS = 'not-a-number';
    expect(getDeliveryTimeouts()).toEqual({
      headersTimeoutMs: 1500,
      bodyTimeoutMs: DEFAULT_DELIVERY_BODY_TIMEOUT_MS,
    });
  });

  it('starts no runner until the flow handler is registered, and starts it then', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();
    // Ready to enqueue, claiming nothing: the CLI, the web UI, a script.
    expect(makeWorkerUtils).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    await queue.queue('__wkf_workflow_test', { runId: 'run_01ABC' });
    expect(workerUtilsMock.addJob).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    // The app registers its flow route (late, after start()): a worker now.
    registerFlowHandler(queue);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await queue.start();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts the runner once when the handler is registered while start() is in flight', async () => {
    const utilsReady = Promise.withResolvers<WorkerUtils>();
    vi.mocked(makeWorkerUtils).mockReturnValueOnce(utilsReady.promise);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const starting = queue.start();
    // Registered while start() waits for the worker utils: neither side may
    // start a second runner, and start() must not resolve without one.
    registerFlowHandler(queue);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
    utilsReady.resolve(workerUtilsMock);
    await starting;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts no runner before the migrations finish, even for a handler registered meanwhile', async () => {
    const migrated = Promise.withResolvers<void>();
    vi.mocked(workerUtilsMock.migrate).mockReturnValueOnce(migrated.promise);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const starting = queue.start();
    await vi.waitFor(() => expect(workerUtilsMock.migrate).toHaveBeenCalled());
    // Registered while the schema is still being migrated: the runner must
    // not claim jobs against it yet.
    registerFlowHandler(queue);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
    migrated.resolve();
    await starting;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts one runner for concurrent start() calls', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue);
    await Promise.all([queue.start(), queue.start(), queue.start()]);
    expect(makeWorkerUtils).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts no runner for a handler registered after close()', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();
    await queue.close();
    registerFlowHandler(queue);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
  });

  it("delivers the Workflow SDK's messages in process only, never over HTTP", async () => {
    const requests: RecordedDelivery[] = [];
    const server = await startWorkflowHttpServer(requests);
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const deliveries: RecordedDelivery[] = [];
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue, deliveries);
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test-step', {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'test-step',
      }),
      { job: { attempts: 1 } }
    );

    expect(requests).toEqual([]);
    expect(deliveries).toEqual([
      expect.objectContaining({
        method: 'in-process',
        url: '/.well-known/workflow/v1/flow',
        headers: expect.objectContaining({
          'x-workflow-queue-name': '__wkf_workflow_test-step',
        }),
      }),
    ]);
    expect(getWorkflowPort).not.toHaveBeenCalled();
  });

  it("keeps the base-url error for a consumer's route when env vars and local port detection cannot resolve a target", async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue);
    queue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    await queue.start();

    const task = getTaskHandler('workflow_flows');
    const payload = buildMessageData(
      '__agent_wkf_workflow_session',
      { runId: 'run_01ABC' } as QueuePayload,
      { idempotencyKey: 'session_01ABC' }
    );

    await expect(task(payload, {} as any)).rejects.toThrow(
      'Unable to resolve base URL for workflow queue.'
    );

    expect(getWorkflowPort).toHaveBeenCalled();
  });

  it('keeps Graphile Worker automatic shutdown by default', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue);

    await queue.start();

    expect(run).toHaveBeenCalledWith(
      expect.not.objectContaining({ noHandleSignals: true })
    );
  });

  it('allows the application to manage shutdown', async () => {
    const queue = buildQueue(
      {
        connectionString: 'postgres://test',
        applicationManagedShutdown: true,
      },
      pool
    );
    registerFlowHandler(queue);

    await queue.start();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ noHandleSignals: true })
    );
  });

  it.each([
    undefined,
    'custom',
  ])('delivers a spec 8 wake while the same run is awaiting an inline step (namespace: %s)', async (namespace) => {
    const firstRequestStarted = Promise.withResolvers<void>();
    const releaseFirstRequest = Promise.withResolvers<void>();
    let requestCount = 0;
    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace },
      pool
    );
    registerFlowHandler(queue, [], {
      prefix: namespace ? `__${namespace}_wkf_workflow_` : undefined,
      beforeResponse: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          firstRequestStarted.resolve();
          await releaseFirstRequest.promise;
        }
      },
    });
    await queue.start();
    const task = getTaskHandler('workflow_flows');
    const queueName = namespace
      ? `__${namespace}_wkf_workflow_test-workflow`
      : '__wkf_workflow_test-workflow';
    const payload = { runId: 'wrun_01ABC' };
    const firstExecution = task(
      buildMessageData(queueName, payload, {
        messageId: MessageId.parse('msg_01ABC'),
      }),
      {}
    );
    let wakeExecution: Promise<void> | undefined;
    try {
      await firstRequestStarted.promise;
      // A wake must reach the runtime before the inline step completes:
      // it may be the hook resumption that aborts that very step.
      wakeExecution = task(
        buildMessageData(queueName, payload, {
          messageId: MessageId.parse('msg_01ABD'),
        }),
        {}
      );
      await expect.poll(() => requestCount, { timeout: 1_000 }).toBe(2);
      await wakeExecution;
    } finally {
      releaseFirstRequest.resolve();
      await Promise.all([firstExecution, wakeExecution]);
    }
  });

  it.each([
    undefined,
    'custom',
  ])('routes a run’s orchestrator deliveries to its own named queue (namespace: %s)', async (namespace) => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace },
      pool
    );
    registerFlowHandler(queue, [], {
      prefix: namespace ? `__${namespace}_wkf_workflow_` : undefined,
    });
    await queue.start();
    const queueName = (
      namespace
        ? `__${namespace}_wkf_workflow_test-workflow`
        : '__wkf_workflow_test-workflow'
    ) as ValidQueueName;
    const spec9 = { runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR };
    await queue.queue(queueName, { runId: 'run_a', ...spec9 });
    await queue.queue(
      queueName,
      { runId: 'run_a', ...spec9 },
      { delaySeconds: 60 }
    );
    await queue.queue(queueName, { runId: 'run_b', ...spec9 });
    await queue.queue(queueName, {
      runId: 'run_a',
      stepId: 'step_a',
      stepName: 'step',
      ...spec9,
    });
    await queue.queue(queueName, {
      __healthCheck: true,
      correlationId: 'hc_a',
      runId: 'run_a',
    });
    // A spec 8 (or unstamped) run's orchestrator deliveries are not
    // serialized: one can hold an inline step until another wake aborts it.
    await queue.queue(queueName, { runId: 'run_c' });
    const options = vi
      .mocked(workerUtilsMock.addJob)
      .mock.calls.map((call) => call[2]);
    // Without invoke, orchestrator deliveries stay on the ordinary task; the
    // named queue alone is what serializes them.
    expect(
      vi.mocked(workerUtilsMock.addJob).mock.calls.map((call) => call[0])
    ).toEqual(Array(6).fill('workflow_flows'));
    expect(options[0]).toMatchObject({
      queueName: 'workflow_flows:run_a:executor',
    });
    expect(options[1]).toMatchObject({
      queueName: 'workflow_flows:run_a:executor',
    });
    expect(options[2]).toMatchObject({
      queueName: 'workflow_flows:run_b:executor',
    });
    expect(options[3]).not.toHaveProperty('queueName');
    expect(options[4]).not.toHaveProperty('queueName');
    expect(options[5]).not.toHaveProperty('queueName');
  });

  it('keeps a rescheduled orchestrator delivery in its run’s named queue', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue, [], { responseBody: { timeoutSeconds: 5 } });
    await queue.start();
    await getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test-workflow', {
        runId: 'run_a',
        runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      }),
      {}
    );
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ queueName: 'workflow_flows:run_a:executor' })
    );
  });

  it('does not require a runId for workflow health-check payloads', async () => {
    const requests: RecordedDelivery[] = [];
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue, requests);
    try {
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      const payload = buildMessageData('__wkf_workflow_health_check', {
        __healthCheck: true,
        correlationId: 'hc_01ABC',
      });

      await expect(task(payload, {} as any)).resolves.toBeUndefined();

      expect(requests).toEqual([
        expect.objectContaining({
          url: '/.well-known/workflow/v1/flow',
          method: 'in-process',
          headers: expect.objectContaining({
            'x-workflow-queue-name': '__wkf_workflow_health_check',
          }),
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses basePath for the request a consumer handler without an in-process entry gets', async () => {
    const requests: RecordedDelivery[] = [];
    setWorkflowBasePath('/v2');

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    // The app's flow handler, so this process runs a worker, and a
    // consumer's handler for its own prefix, taking the request shape (no
    // in-process entry); only the SDK's prefix requires the entry.
    registerFlowHandler(queue);
    queue.registerHandler('__agent_wkf_workflow_', async (req) => {
      requests.push({
        method: req.method,
        url: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
      return Response.json({ ok: true });
    });
    try {
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      const payload = buildMessageData('__agent_wkf_workflow_test-step', {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'test-step',
      });

      await expect(task(payload, {} as any)).resolves.toBeUndefined();

      expect(requests).toEqual([
        expect.objectContaining({
          url: '/v2/.well-known/workflow/v1/flow',
          method: 'POST',
        }),
      ]);
      expect(getWorkflowPort).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('queues producer delays and headers in graphile job metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    try {
      const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
      await queue.start();

      await queue.queue(
        '__wkf_workflow_test-step',
        {
          runId: 'run_01ABC',
          stepId: 'step_01ABC',
          stepName: 'test-step',
        },
        {
          delaySeconds: 5,
          headers: { traceparent: 'trace-parent' },
          idempotencyKey: 'step_01ABC',
        }
      );

      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows',
        expect.objectContaining({
          attempt: 1,
          headers: { traceparent: 'trace-parent' },
          id: 'test-step',
          idempotencyKey: 'step_01ABC',
        }),
        expect.objectContaining({
          jobKey: 'step_01ABC',
          maxAttempts: 73,
          runAt: new Date('2024-01-01T00:00:05.000Z'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the first schedule when a keyed delayed job is published again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    try {
      const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
      await queue.start();
      const message = {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'retrying-step',
      } as const;

      await queue.queue('__wkf_workflow_test-step', message, {
        delaySeconds: 5,
        idempotencyKey: 'step_01ABC',
      });
      await queue.queue('__wkf_workflow_test-step', message, {
        idempotencyKey: 'step_01ABC',
      });

      expect(workerUtilsMock.addJob).toHaveBeenCalledTimes(2);
      expect(workerUtilsMock.addJob).toHaveBeenNthCalledWith(
        2,
        'workflow_flows',
        expect.anything(),
        expect.objectContaining({
          jobKey: 'step_01ABC',
          jobKeyMode: 'preserve_run_at',
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates a spec 9 run's keyed message against any job holding its key", async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();
    const spec9 = { runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR };
    // A step's execution message, a wait's last timer, and an intermediate
    // hop of a long wait's timer, each keyed by the runtime.
    await queue.queue(
      '__wkf_workflow_test-step',
      { runId: 'run_01ABC', stepId: 'step_01ABC', stepName: 'step', ...spec9 },
      { idempotencyKey: 'step_01ABC' }
    );
    await queue.queue(
      '__wkf_workflow_test',
      {
        runId: 'run_01ABC',
        waitContinuation: { correlationId: 'wait_01ABC', attempt: 0 },
        ...spec9,
      },
      { idempotencyKey: 'wait:wait_01ABC:2000:2000', delaySeconds: 3 }
    );
    await queue.queue(
      '__wkf_workflow_test',
      {
        runId: 'run_01ABC',
        waitContinuation: {
          correlationId: 'wait_01ABC',
          attempt: 0,
          resumeAtMs: 2000,
          hopAtMs: 1000,
        },
        ...spec9,
      },
      { idempotencyKey: 'wait:wait_01ABC:2000:1000', delaySeconds: 1 }
    );
    // A wake carries no key: its job key is its message id, whatever mode.
    await queue.queue('__wkf_workflow_test', { runId: 'run_01ABC', ...spec9 });
    const modes = vi
      .mocked(workerUtilsMock.addJob)
      .mock.calls.map(
        (call) => (call[2] as { jobKeyMode?: string } | undefined)?.jobKeyMode
      );
    expect(modes).toEqual([
      'unsafe_dedupe',
      'unsafe_dedupe',
      'unsafe_dedupe',
      'preserve_run_at',
    ]);
  });

  it('keeps replace semantics for a rescheduled spec 9 delivery, which is sent while its job is locked', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue, [], { responseBody: { timeoutSeconds: 7 } });
    await queue.start();
    await getTaskHandler('workflow_flows')(
      buildMessageData(
        '__wkf_workflow_test-step',
        {
          runId: 'run_01ABC',
          stepId: 'step_01ABC',
          stepName: 'test-step',
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        },
        { idempotencyKey: 'step_01ABC' }
      ),
      { job: { attempts: 1 } }
    );
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.anything(),
      expect.objectContaining({
        jobKey: 'step_01ABC',
        jobKeyMode: 'preserve_run_at',
      })
    );
  });

  it('stamps createdAt on a new message and keeps an idempotency key off a wake', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();
    await queue.queue('__wkf_workflow_test', { runId: 'run_01ABC' });
    const [, data, options] = vi.mocked(workerUtilsMock.addJob).mock
      .calls[0] as [string, MessageData, { jobKey?: string }];
    expect(new Date(data.createdAt ?? '').getTime()).not.toBeNaN();
    expect(data.idempotencyKey).toBeUndefined();
    // A wake's job key is its own message id, so two wakes never collapse.
    expect(options.jobKey).toBe(data.messageId);
  });

  it('redelivers the same message on timeoutSeconds: same id and createdAt, next attempt', async () => {
    const requests: RecordedDelivery[] = [];
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue, requests, {
      responseBody: { timeoutSeconds: 7 },
    });
    await queue.start();

    const createdAt = '2026-10-05T00:00:00.000Z';
    const messageId = MessageId.parse('msg_01STEP');
    await getTaskHandler('workflow_flows')(
      buildMessageData(
        '__wkf_workflow_test-step',
        { runId: 'run_01ABC', stepId: 'step_01ABC', stepName: 'test-step' },
        { messageId, createdAt, idempotencyKey: 'step_01ABC', attempt: 2 }
      ),
      { job: { attempts: 2 } }
    );

    expect(requests[0]?.headers).toMatchObject({
      'x-workflow-message-id': messageId,
      'x-workflow-message-attempt': '2',
      'x-workflow-message-created-at': createdAt,
    });
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({
        messageId,
        createdAt,
        attempt: 3,
        idempotencyKey: 'step_01ABC',
      }),
      expect.objectContaining({ jobKey: 'step_01ABC' })
    );
  });

  it('defaults pollInterval to 500ms and honors an override from config', async () => {
    const defaultQueue = buildQueue(
      { connectionString: 'postgres://test' },
      pool
    );
    registerFlowHandler(defaultQueue);
    await defaultQueue.start();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ pollInterval: 500 })
    );

    const overriddenQueue = buildQueue(
      { connectionString: 'postgres://test', pollInterval: 2000 },
      pool
    );
    registerFlowHandler(overriddenQueue);
    await overriddenQueue.start();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ pollInterval: 2000 })
    );
  });

  it('uses per-run executor queues without serializing step jobs when invoke is enabled', async () => {
    const queue = buildQueue(
      {
        connectionString: 'postgres://test',
        enableInvoke: true,
        queueConcurrency: 7,
      },
      pool
    );
    registerFlowHandler(queue);
    await queue.start();
    expect(queue.invoke).toBeTypeOf('function');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        concurrency: 7,
        taskList: {
          workflow_flows: expect.any(Function),
          workflow_flows_executor: expect.any(Function),
        },
      })
    );
    await queue.queue('__wkf_workflow_example', { runId: 'run_a' });
    await queue.queue('__wkf_workflow_example', { runId: 'run_b' });
    await queue.queue('__wkf_workflow_example', {
      runId: 'run_a',
      stepId: 'step_a',
      stepName: 'step',
    });
    const calls = vi.mocked(workerUtilsMock.addJob).mock.calls;
    expect(calls[0]).toEqual([
      'workflow_flows_executor',
      expect.any(Object),
      expect.objectContaining({ queueName: 'workflow_flows:run_a:executor' }),
    ]);
    expect(calls[1][2]).toMatchObject({
      queueName: 'workflow_flows:run_b:executor',
    });
    expect(calls[2][0]).toBe('workflow_flows');
    expect(calls[2][2]).not.toHaveProperty('queueName');
  });

  it('transfers legacy orchestration before execution and preserves its retry budget', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    const deliveries: RecordedDelivery[] = [];
    registerFlowHandler(queue, deliveries);
    await queue.start();
    {
      const payload = buildMessageData(
        '__wkf_workflow_example',
        {
          runId: 'run_a',
          runInput: {
            input: new Uint8Array([1]),
            deploymentId: 'postgres',
            workflowName: 'example',
            specVersion: 7,
          },
        },
        { idempotencyKey: 'legacy-key' }
      );
      await getTaskHandler('workflow_flows')(payload, {
        job: { attempts: 4, max_attempts: 9 },
      });
      expect(deliveries).toEqual([]);
      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows_executor',
        expect.objectContaining({ ...payload, attempt: 4, attemptOffset: 3 }),
        expect.objectContaining({
          queueName: 'workflow_flows:run_a:executor',
          jobKey: `workflow_flows_executor:transfer:${payload.messageId}`,
          maxAttempts: 6,
        })
      );
    }
  });

  it('keeps post-ceiling headroom when transferring a job on the default cap', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    const deliveries: RecordedDelivery[] = [];
    registerFlowHandler(queue, deliveries);
    await queue.start();
    {
      const payload = buildMessageData('__wkf_workflow_example', {
        runId: 'run_a',
      });
      // Delivery 49 is where core records MAX_DELIVERIES_EXCEEDED. A job with
      // no stored cap takes the default, so the transferred job must still
      // have attempts left for core's post-ceiling redeliveries (73 - 49 + 1).
      await getTaskHandler('workflow_flows')(payload, {
        job: { attempts: 49 },
      });
      expect(deliveries).toEqual([]);
      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows_executor',
        expect.objectContaining({ attempt: 49, attemptOffset: 48 }),
        expect.objectContaining({ maxAttempts: 25 })
      );
    }
  });

  it('does not acknowledge a legacy transfer when enqueue fails', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    registerFlowHandler(queue);
    await queue.start();
    vi.mocked(workerUtilsMock.addJob).mockRejectedValueOnce(
      new Error('transfer failed')
    );
    await expect(
      getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_example', { runId: 'run_a' }),
        { job: { attempts: 1 } }
      )
    ).rejects.toThrow('transfer failed');
  });

  it('admits an executor delivery against the jobs view only for a job on the expected named queue', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    const deliveries: RecordedDelivery[] = [];
    registerFlowHandler(queue, deliveries);
    // An admitted orchestrator delivery drives the run with its mailbox's
    // pending inputs: none here.
    invocationTransport.feed.mockReturnValue({
      return: vi.fn().mockResolvedValue({ done: true }),
      async next() {
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    await queue.start();
    const payload = buildMessageData(
      '__wkf_workflow_example',
      { runId: 'run_a' },
      {
        headers: {
          'X-Workflow-Postgres-Executor-Job': 'forged',
          'X-Workflow-Postgres-Executor-Worker': 'forged',
          'X-Workflow-Postgres-Executor-Attempt': '99',
        },
      }
    );
    const helpers = {
      job: {
        id: '42',
        attempts: 2,
        max_attempts: 49,
        locked_by: 'worker-real',
        task_identifier: 'workflow_flows_executor',
      },
      getQueueName: vi.fn().mockResolvedValue(null),
    };
    {
      const execute = getTaskHandler('workflow_flows_executor');
      await execute(payload, helpers);
      expect(deliveries).toEqual([]);
      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows_executor',
        expect.anything(),
        expect.objectContaining({ queueName: 'workflow_flows:run_a:executor' })
      );
      helpers.getQueueName.mockResolvedValue('workflow_flows:run_a:executor');
      await execute(payload, helpers);
      // Delivered in process once admitted: the job's own provenance, never
      // the forged headers on the message, is what is checked.
      expect(deliveries).toHaveLength(1);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('graphile_worker.jobs'),
        [
          '42',
          'workflow_flows_executor',
          'workflow_flows:run_a:executor',
          'worker-real',
          2,
        ]
      );
    }
  });

  it('delivers a step message in process without an executor admission, whatever headers it carries', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    const deliveries: RecordedDelivery[] = [];
    registerFlowHandler(queue, deliveries);
    await queue.start();
    await getTaskHandler('workflow_flows')(
      buildMessageData(
        '__wkf_workflow_example',
        { runId: 'run_a', stepId: 'step_a', stepName: 'step' },
        {
          headers: {
            'X-Workflow-Postgres-Executor-Job': '42',
            'x-workflow-postgres-executor-worker': 'forged',
            'X-Workflow-Postgres-Executor-Attempt': '2',
          },
        }
      ),
      { job: { attempts: 1 } }
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.headers).not.toHaveProperty(
      'x-workflow-postgres-executor-job'
    );
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('graphile_worker.jobs'),
      expect.anything()
    );
  });

  function receiver() {
    // The Postgres delivery handler, as a flow route serves it.
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    const handler = vi.fn().mockResolvedValue(undefined);
    return {
      handler,
      receive: queue.createQueueHandler('__wkf_workflow_', handler),
    };
  }

  function request(
    headers: Record<string, string> = {},
    body: unknown = { runId: 'run_a' }
  ) {
    return new Request('http://executor.test/flow', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'x-vqs-message-id': 'msg_receiver',
        'x-vqs-message-attempt': '3',
        'x-vqs-queue-name': '__wkf_workflow_example',
        ...headers,
      },
    });
  }

  const proof = {
    'x-workflow-postgres-executor-job': '42',
    'x-workflow-postgres-executor-worker': 'worker-real',
    'x-workflow-postgres-executor-attempt': '3',
  };

  it('reroutes unmarked HTTP orchestration without reading the mailbox or running core', async () => {
    const { handler, receive } = receiver();
    await receive(request());
    // An invalid health-check marker must not bypass executor routing.
    await receive(request({}, { runId: 'run_a', __healthCheck: false }));
    expect(handler).not.toHaveBeenCalled();
    expect(invocationTransport.pending).not.toHaveBeenCalled();
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows_executor',
      expect.objectContaining({
        messageId: 'msg_receiver',
        attempt: 3,
        attemptOffset: 2,
      }),
      expect.objectContaining({ queueName: 'workflow_flows:run_a:executor' })
    );
  });

  it('refuses inactive/wrong-queue executor evidence before supplying a feed', async () => {
    const { handler, receive } = receiver();
    pool.query.mockResolvedValue({ rows: [] });
    // The handler answers a thrown refusal as a 500, which fails the
    // Graphile job so the queue retries it.
    const refused = await receive(request(proof));
    expect(refused.status).toBe(500);
    expect(await refused.json()).toContain('not active on the run queue');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('graphile_worker.jobs'),
      [
        '42',
        'workflow_flows_executor',
        'workflow_flows:run_a:executor',
        'worker-real',
        3,
      ]
    );
    expect(handler).not.toHaveBeenCalled();
    expect(invocationTransport.pending).not.toHaveBeenCalled();
  });

  it('delivers invocation-mode handler calls and stores their return values without exposing a feed', async () => {
    const { handler, receive } = receiver();
    pool.query.mockResolvedValue({ rows: [{ id: '42' }] });
    const pending = [{ id: 'request', payload: { value: 'input' } }];
    const feed = {
      return: vi.fn().mockResolvedValue({ done: true }),
      async next() {
        const value = pending.shift();
        return value ? { done: false, value } : { done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    invocationTransport.feed.mockReturnValue(feed);
    handler.mockImplementation(async (message) =>
      message.invoke ? { timeoutSeconds: 123, value: 'data' } : undefined
    );
    await receive(request(proof));
    expect(invocationTransport.pending).toHaveBeenCalledWith('run_a');
    expect(handler).toHaveBeenCalledWith(
      {
        runId: 'run_a',
        invoke: true,
        requestId: 'request',
        input: { value: 'input' },
      },
      expect.not.objectContaining({ invocations: expect.anything() })
    );
    expect(invocationTransport.respondOutcome).toHaveBeenCalledExactlyOnceWith(
      'run_a',
      'request',
      { ok: true, value: { timeoutSeconds: 123, value: 'data' } }
    );
    expect(feed.return).toHaveBeenCalledOnce();
    handler.mockClear();
    await receive(
      request(proof, { runId: 'run_a', stepId: 'step_a', stepName: 'step' })
    );
    expect(handler.mock.calls[0][1]).not.toHaveProperty('invocations');
    handler.mockClear();
    await receive(
      request(proof, {
        runId: 'run_a',
        __healthCheck: true,
        correlationId: 'probe',
      })
    );
    expect(handler.mock.calls[0][1]).not.toHaveProperty('invocations');
  });

  it('queues namespaced producer messages in graphile job metadata', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace: 'custom' },
      pool
    );
    await queue.start();
    // A producer only: nothing registered, no runner.
    expect(run).not.toHaveBeenCalled();

    await queue.queue(
      '__custom_wkf_workflow_test-step',
      {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'test-step',
      },
      {
        idempotencyKey: 'step_01ABC',
      }
    );

    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({
        attempt: 1,
        id: 'test-step',
        idempotencyKey: 'step_01ABC',
      }),
      expect.objectContaining({
        jobKey: 'step_01ABC',
        maxAttempts: 73,
      })
    );
  });

  it("renews a running delivery's job lock and releases stale locks while the runner runs", async () => {
    pool.query.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('unnest(')
        ? {
            rows: (params?.[1] as string[]).map((worker, i) => ({
              id: (params?.[0] as string[])[i],
              worker,
            })),
          }
        : { rows: [{ exists: false }] }
    );
    const queue = createQueue(
      { connectionString: 'postgres://test', jobLockStaleSeconds: 1 },
      pool
    );
    const server = registerFlowHandler(queue, [], { hang: true });
    try {
      await queue.start();
      const controller = new AbortController();
      const execution = getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
        {
          abortSignal: controller.signal,
          job: {
            attempts: 1,
            id: '7',
            locked_by: 'worker-a',
            task_identifier: 'workflow_flows',
          },
        }
      );
      await server.requestReceived;
      await vi.waitFor(
        () => {
          expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('unnest('),
            [['7'], ['worker-a']]
          );
          expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('"graphile_worker"._private_tasks'),
            [1, ['workflow_flows', 'workflow_flows_executor']]
          );
        },
        { timeout: 2_000 }
      );
      controller.abort();
      await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await queue.close();
    }
    const queriesAtClose = pool.query.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pool.query).toHaveBeenCalledTimes(queriesAtClose);
  });

  it('reads the stale window from WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS', async () => {
    process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS = '1';
    const queue = buildQueue(
      { connectionString: 'postgres://test', jobPrefix: 'myapp_' },
      pool
    );
    registerFlowHandler(queue);
    await queue.start();
    await vi.waitFor(
      () => {
        expect(pool.query).toHaveBeenCalledWith(
          expect.stringContaining('"graphile_worker"._private_tasks'),
          [1, ['myapp_flows', 'myapp_flows_executor']]
        );
      },
      { timeout: 2_000 }
    );
  });

  it('by default releases only stale per-run named-queue jobs of renewing holders', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', jobPrefix: 'myapp_' },
      pool,
      { defaultJobLockStaleSeconds: 1 }
    );
    registerFlowHandler(queue);
    await queue.start();
    await vi.waitFor(
      () => {
        expect(pool.query).toHaveBeenCalledWith(
          expect.stringContaining('"workflow"."workflow_job_lock_holders"'),
          [
            1,
            ['myapp_flows', 'myapp_flows_executor'],
            'myapp_flows:',
            ':executor',
          ]
        );
      },
      { timeout: 2_000 }
    );
  });

  it('turns renewal and the release of stale locks off with jobLockStaleSeconds: 0', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', jobLockStaleSeconds: 0 },
      pool,
      { defaultJobLockStaleSeconds: 1 }
    );
    registerFlowHandler(queue);
    await queue.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('_private_tasks'),
      expect.anything()
    );
  });

  it('keeps the queue prefix, and the route registered for it, on the job', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    await queue.start();
    // A route alone makes no worker: only the flow handler does.
    expect(run).not.toHaveBeenCalled();

    await queue.queue('__agent_wkf_workflow_session', {
      runId: 'run_01ABC',
    } as QueuePayload);
    await queue.queue('__wkf_workflow_myWorkflow', { runId: 'run_01DEF' });

    const jobs = vi
      .mocked(workerUtilsMock.addJob)
      .mock.calls.map(([, payload]) => MessageData.parse(payload));
    expect(jobs).toEqual([
      expect.objectContaining({
        id: 'session',
        prefix: '__agent_wkf_workflow_',
        route: '/api/agent/queue',
      }),
      expect.objectContaining({ id: 'myWorkflow', prefix: '__wkf_workflow_' }),
    ]);
    expect(jobs[1]).not.toHaveProperty('route');
  });

  it("delivers a job under its own prefix to that prefix's route", async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/api/agent/queue'
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    // A worker whose own prefix is the Workflow SDK's default.
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    registerFlowHandler(queue);
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData('__agent_wkf_workflow_session', { runId: 'run_01ABC' }),
      { job: { attempts: 1 } }
    );

    expect(requests).toEqual([
      expect.objectContaining({ method: 'POST', url: '/api/agent/queue' }),
    ]);
    expect(requests[0]?.headers['x-workflow-queue-name']).toBe(
      '__agent_wkf_workflow_session'
    );
    // And the earlier release's names, for a route on that release.
    expect(requests[0]?.headers['x-vqs-queue-name']).toBe(
      '__agent_wkf_workflow_session'
    );
  });

  it('delivers to the route the producer recorded when this worker has none', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/api/agent/queue'
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue);
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData(
        '__agent_wkf_workflow_session',
        { runId: 'run_01ABC' },
        { route: '/api/agent/queue' }
      ),
      { job: { attempts: 1 } }
    );

    expect(requests.map((r) => r.url)).toEqual(['/api/agent/queue']);
  });

  it("sends a prefix with no route to the Workflow SDK's flow route", async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await startWorkflowHttpServer(requests);
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    registerFlowHandler(queue);
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData('__agent_wkf_workflow_session', { runId: 'run_01ABC' }),
      { job: { attempts: 1 } }
    );

    expect(requests.map((r) => r.url)).toEqual([
      '/.well-known/workflow/v1/flow',
    ]);
    // The queue name it was sent to, not rebuilt with the worker's prefix.
    expect(requests[0]?.headers['x-workflow-queue-name']).toBe(
      '__agent_wkf_workflow_session'
    );
  });

  it("rebuilds a job without a stored prefix with the worker's own, as before", async () => {
    const requests: RecordedDelivery[] = [];
    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace: 'custom' },
      pool
    );
    registerFlowHandler(queue, requests, { prefix: '__custom_wkf_workflow_' });
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData(
        '__wkf_workflow_myWorkflow',
        { runId: 'run_01ABC' },
        { legacy: true }
      ),
      { job: { attempts: 1 } }
    );

    expect(requests[0]?.headers['x-workflow-queue-name']).toBe(
      '__custom_wkf_workflow_myWorkflow'
    );
  });

  it('delivers to an in-process handler for the prefix without HTTP', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await startWorkflowHttpServer(requests, 0, '/any');
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const seen: { url: string; queueName: string | null; body: unknown }[] = [];
    queue.registerRoute('__agent_wkf_workflow_', '/api/agent/queue');
    queue.registerHandler('__agent_wkf_workflow_', async (req) => {
      seen.push({
        url: new URL(req.url).pathname,
        queueName: req.headers.get('x-workflow-queue-name'),
        body: await req.json(),
      });
      return Response.json({ timeoutSeconds: 30 });
    });
    registerFlowHandler(queue);
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData('__agent_wkf_workflow_session', { runId: 'run_01ABC' }),
      { job: { attempts: 1 } }
    );

    expect(requests).toHaveLength(0);
    expect(seen).toEqual([
      {
        url: '/api/agent/queue',
        queueName: '__agent_wkf_workflow_session',
        body: { runId: 'run_01ABC' },
      },
    ]);
    // `{ timeoutSeconds }` reschedules the same message under its prefix.
    const [, rescheduled, options] =
      vi.mocked(workerUtilsMock.addJob).mock.calls[0] ?? [];
    expect(MessageData.parse(rescheduled)).toMatchObject({
      id: 'session',
      prefix: '__agent_wkf_workflow_',
    });
    expect(options?.runAt).toBeInstanceOf(Date);
  });

  it('rejects an invalid prefix or route', () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    expect(() =>
      queue.registerRoute('__agent_wkf_workflow_', 'api/agent/queue')
    ).toThrow(TypeError);
    expect(() =>
      queue.registerRoute('agent' as never, '/api/agent/queue')
    ).toThrow();
    expect(() =>
      queue.registerHandler('agent' as never, async () => Response.json({}))
    ).toThrow();
  });

  it("delivers to a registered handler's in-process entry when it has one", async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const viaRoute = vi.fn(async () => Response.json({ ok: true }));
    const viaEntry = vi.fn(async ({ message, meta }: InProcessDelivery) => {
      // The message and its metadata, no request.
      expect(meta).toMatchObject({
        queueName: '__wkf_workflow_test',
        messageId: 'msg_01ABC',
        attempt: 1,
        deliveryCount: 1,
      });
      expect(message).toEqual({ runId: 'run_01ABC' });
      return undefined;
    });
    const handler: QueueRouteHandler = Object.assign(viaRoute, {
      [IN_PROCESS_QUEUE_HANDLER]: viaEntry,
    });
    queue.registerHandler('__wkf_workflow_', handler);
    await queue.start();

    await getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
      { job: { attempts: 1 } }
    );

    expect(viaEntry).toHaveBeenCalledOnce();
    expect(viaRoute).not.toHaveBeenCalled();
  });

  it("refuses a flow handler without the in-process entry for the SDK's own prefix", async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    expect(() =>
      queue.registerHandler('__wkf_workflow_', async () =>
        Response.json({ ok: true })
      )
    ).toThrow(/registerWorkflowHandler/);
    // A consumer's handler for another prefix keeps the request shape.
    expect(() =>
      queue.registerHandler('__agent_wkf_workflow_', async () =>
        Response.json({ ok: true })
      )
    ).not.toThrow();
  });

  it('fails an in-process delivery when the job is aborted, and leaves the job to Graphile', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const entered = Promise.withResolvers<void>();
    queue.registerHandler(
      '__wkf_workflow_',
      withEntry(async () => {
        entered.resolve();
        // Hangs, as a handler running a long inline step does; the abort
        // releases the job, not the handler.
        await new Promise(() => {});
      })
    );
    await queue.start();

    const controller = new AbortController();
    const execution = getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
      { abortSignal: controller.signal, job: { attempts: 1 } }
    );
    await entered.promise;
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    // Rejecting hands the job back to Graphile for redelivery; the queue
    // must not schedule a replacement of its own.
    expect(workerUtilsMock.addJob).not.toHaveBeenCalled();
  });

  it('hands the in-process handler the signal, aborted when the job is aborted', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const entered = Promise.withResolvers<void>();
    let seen: AbortSignal | undefined;
    queue.registerHandler(
      '__wkf_workflow_',
      withEntry(async ({ signal }) => {
        seen = signal;
        entered.resolve();
        await new Promise(() => {});
      })
    );
    await queue.start();

    const controller = new AbortController();
    const execution = getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
      { abortSignal: controller.signal, job: { attempts: 1 } }
    );
    await entered.promise;
    expect(seen?.aborted).toBe(false);
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    // The handler sees the abort through the delivery's signal.
    expect(seen?.aborted).toBe(true);
  });

  it('hands the in-process handler a signal that fires at the headers deadline', async () => {
    process.env.WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS = '50';
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const timedOut = Promise.withResolvers<void>();
    queue.registerHandler(
      '__wkf_workflow_',
      withEntry(async ({ signal }) => {
        signal?.addEventListener('abort', () => timedOut.resolve(), {
          once: true,
        });
        await new Promise(() => {});
      })
    );
    await queue.start();

    await expect(
      getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
        { job: { attempts: 1 } }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    await timedOut.promise;
  });

  it('fails an in-process delivery that does not respond within the headers deadline', async () => {
    process.env.WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS = '50';
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.registerHandler(
      '__wkf_workflow_',
      withEntry(async () => {
        await new Promise(() => {});
      })
    );
    await queue.start();

    await expect(
      getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
        { job: { attempts: 1 } }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('places no deadline on an in-process delivery unless the operator sets one', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    // No deadline, no shutdown: nothing can abort the delivery, and the
    // handler gets no signal to watch.
    queue.registerHandler(
      '__wkf_workflow_',
      withEntry(async ({ signal }) => {
        expect(signal).toBeUndefined();
        return undefined;
      })
    );
    await queue.start();
    await expect(
      getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
        { job: { attempts: 1 } }
      )
    ).resolves.toBeUndefined();
  });

  it('leaves no abort listener on the shared signal once a delivery settles', async () => {
    // With no deadline the delivery races Graphile's own signal, shared by
    // every job of the runner: a listener left behind per delivery would
    // accumulate for the life of the process.
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.registerHandler(
      '__wkf_workflow_',
      Object.assign(async () => Response.json({ ok: true }), {
        [IN_PROCESS_QUEUE_HANDLER]: async () => undefined,
      })
    );
    await queue.start();
    const controller = new AbortController();
    for (let i = 0; i < 15; i++) {
      await getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test', { runId: `run_${i}` }),
        { abortSignal: controller.signal, job: { attempts: 1 } }
      );
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('holds the run gate until a timed-out in-process handler settles', async () => {
    process.env.WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS = '100';
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const first = Promise.withResolvers<void>();
    const entry = vi.fn(async () => {
      // The first delivery outlives its deadline; the handler keeps running.
      if (entry.mock.calls.length === 1) await first.promise;
      return undefined;
    });
    queue.registerHandler(
      '__wkf_workflow_',
      Object.assign(async () => Response.json({ ok: true }), {
        [IN_PROCESS_QUEUE_HANDLER]: entry,
      })
    );
    await queue.start();
    const message = () =>
      buildMessageData('__wkf_workflow_test', {
        runId: 'run_01ABC',
        runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      });
    await expect(
      getTaskHandler('workflow_flows')(message(), { job: { attempts: 1 } })
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The redelivery waits at the gate while the first handler still runs,
    // rather than replaying the run next to it.
    const second = getTaskHandler('workflow_flows')(message(), {
      job: { attempts: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(entry).toHaveBeenCalledTimes(1);
    first.resolve();
    await expect(second).resolves.toBeUndefined();
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it('notes once that a process without the flow handler only enqueues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notes = () =>
      warn.mock.calls.filter((call) =>
        String(call[0]).includes('only enqueues')
      );
    try {
      const enqueuer = buildQueue(
        { connectionString: 'postgres://test' },
        pool
      );
      await enqueuer.start();
      await enqueuer.start();
      expect(notes()).toHaveLength(1);

      const worker = buildQueue({ connectionString: 'postgres://test' }, pool);
      worker.registerHandler(
        '__wkf_workflow_',
        withEntry(async () => undefined)
      );
      await worker.start();
      expect(notes()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves job attempts for redeliveries past core max deliveries', async () => {
    // Core records MAX_DELIVERIES_EXCEEDED on delivery 49 and throws when that
    // terminal write fails transiently. The job must still have attempts left
    // for the redelivery, or the run is stranded `running`.
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();

    await queue.queue('__wkf_workflow_example', { runId: 'run_01ABC' });

    const [, , options] = vi.mocked(workerUtilsMock.addJob).mock.calls[0];
    expect(options?.maxAttempts).toBeGreaterThan(49);
  });
});

function buildQueue(
  config: Parameters<typeof createQueue>[0],
  pgPool: Parameters<typeof createQueue>[1],
  internal?: Parameters<typeof createQueue>[2]
) {
  const queue = createQueue(config, pgPool, internal);
  createdQueues.push(queue);
  return queue;
}

function buildMessageData(
  queueName: string,
  payload: QueuePayload,
  opts?: {
    attempt?: number;
    headers?: Record<string, string>;
    idempotencyKey?: string;
    messageId?: MessageId;
    createdAt?: string;
    route?: string;
    /** A job enqueued before the prefix was stored. */
    legacy?: boolean;
  }
) {
  const { id, prefix } = parseQueueName(queueName as ValidQueueName);

  return MessageData.encode({
    id,
    ...(opts?.legacy ? {} : { prefix }),
    ...(opts?.route ? { route: opts.route } : {}),
    data: transport.serialize(payload),
    attempt: opts?.attempt ?? 1,
    headers: opts?.headers,
    idempotencyKey: opts?.idempotencyKey,
    messageId: opts?.messageId ?? MessageId.parse('msg_01ABC'),
    ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

type RecordedDelivery = {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/**
 * Registers the Workflow SDK's flow handler on `queue`, as the app does when
 * it starts, so the queue runs a worker in this process. Each in-process
 * delivery is recorded in `deliveries` in the shape the HTTP server helper
 * records (method, path, headers, body). `hang` holds every delivery until
 * its request is aborted, like a handler running a long inline step.
 */
/** A flow handler that only has the in-process entry a worker delivers to. */
function withEntry(
  entry: (delivery: InProcessDelivery) => Promise<unknown>
): QueueRouteHandler {
  return Object.assign(async () => Response.json({ ok: true }), {
    [IN_PROCESS_QUEUE_HANDLER]: entry,
  });
}

function registerFlowHandler(
  queue: ReturnType<typeof createQueue>,
  deliveries: RecordedDelivery[] = [],
  options: {
    prefix?: string;
    beforeResponse?: () => Promise<void>;
    responseBody?: unknown;
    hang?: boolean;
  } = {}
) {
  const requestReceived = Promise.withResolvers<void>();
  const settle = async () => {
    requestReceived.resolve();
    if (options.hang) await new Promise<never>(() => {});
    if (options.beforeResponse) await options.beforeResponse();
  };
  // The flow route: the Postgres World delivers to its in-process entry,
  // with the message and its metadata; the request shape is kept for a
  // handler without one.
  const handler: QueueRouteHandler = Object.assign(
    async (req: Request) => {
      const body = await req.text();
      deliveries.push({
        method: req.method,
        url: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body,
      });
      await settle();
      return Response.json(options.responseBody ?? { ok: true });
    },
    {
      [IN_PROCESS_QUEUE_HANDLER]: async ({
        message,
        meta,
      }: InProcessDelivery) => {
        // Recorded as the wire form would read, so assertions share a shape.
        deliveries.push({
          method: 'in-process',
          url: '/.well-known/workflow/v1/flow',
          headers: queueDeliveryHeaders({
            queueName: meta.queueName,
            messageId: meta.messageId,
            attempt: meta.attempt,
            deliveryCount: meta.deliveryCount,
            createdAt: meta.createdAt?.toISOString(),
          }),
          body: JSON.stringify(message),
        });
        await settle();
        return options.responseBody;
      },
    }
  );
  queue.registerHandler(
    (options.prefix ?? '__wkf_workflow_') as QueuePrefix,
    handler
  );
  return { requestReceived: requestReceived.promise };
}

function getTaskHandler(name: 'workflow_flows') {
  const taskList = vi.mocked(run).mock.calls[0]?.[0]?.taskList;
  const task = taskList?.[name];
  expect(task).toBeTypeOf('function');
  return task as (payload: unknown, helpers: unknown) => Promise<void>;
}

async function startWorkflowHttpServer(
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>,
  port = 0,
  path = '/.well-known/workflow/v1/flow',
  beforeResponse?: () => Promise<void>,
  responseBody: unknown = { ok: true }
) {
  const server = createServer(async (req, res) => {
    const body = await new Promise<string>((resolve, reject) => {
      let chunks = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        chunks += chunk;
      });
      req.on('end', () => resolve(chunks));
      req.on('error', reject);
    });

    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    };
    requests.push(request);

    if (req.method === 'POST' && req.url === path) {
      if (beforeResponse) await beforeResponse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  createdServers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

// Known gap, see `createTaskHandler`: a reschedule starts `attempt` over.
it.todo(
  'keeps attempt across a { timeoutSeconds: 0 } handoff of a spec 9 orchestrator message'
);
