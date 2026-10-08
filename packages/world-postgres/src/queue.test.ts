import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { type ClientRequest, createServer, type Server } from 'node:http';
import { JsonTransport } from '@vercel/queue';
import { setWorkflowBasePath } from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueuePayload,
  ValidQueueName,
} from '@workflow/world';
import * as nodeHttp from '@workflow/world/node-http';
import { createWorld } from '@workflow/world-local';
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

vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();

  return {
    ...actual,
    createWorld: vi.fn(actual.createWorld),
  };
});

describe('postgres queue http execution', () => {
  const workerUtilsMock = {
    addJob: vi.fn(),
    migrate: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const runnerMock = {
    stop: vi.fn(),
    promise: Promise.resolve(),
    events: new EventEmitter(),
  };
  const wrappedHandler = vi.fn(async () => Response.json({ ok: true }));
  const localWorldClose = vi.fn();
  const createQueueHandler = vi.fn<Queue['createQueueHandler']>(
    () => wrappedHandler
  );
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    runnerMock.events.removeAllListeners();
    invocationTransport.pending.mockResolvedValue([]);
    invocationTransport.close.mockResolvedValue(undefined);
    invocationTransport.respondOutcome.mockResolvedValue(undefined);
    createQueueHandler.mockImplementation(() => wrappedHandler);
    pool.query.mockResolvedValue({ rows: [{ exists: false }] });

    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(runnerMock as unknown as Runner);
    vi.mocked(createWorld).mockReturnValue({
      createQueueHandler,
      close: localWorldClose,
    } as any);
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

  it('fails a delivery whose handler exceeds an operator-set headers deadline', async () => {
    const server = await startHangingWorkflowHttpServer('headers');
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    process.env.WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS = '50';

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();

    const execution = getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test-step', {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'test-step',
      }),
      { abortSignal: new AbortController().signal, job: { attempts: 1 } }
    );

    // Rejecting hands the job back to Graphile for redelivery; the queue
    // must not schedule a replacement of its own.
    await expect(execution).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(workerUtilsMock.addJob).not.toHaveBeenCalled();
  });

  it('uses a late-detected local port when the queue starts before PORT is available', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const port = await getUnusedLoopbackPort();
    vi.mocked(getWorkflowPort).mockResolvedValue(port);

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();

    expect(run).not.toHaveBeenCalled();

    await startWorkflowHttpServer(requests, port);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    const task = getTaskHandler('workflow_flows');
    const message = {
      runId: 'run_01ABC',
      stepId: 'step_01ABC',
      stepName: 'test-step',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_workflow_test-step', message, {
      headers: { traceparent: 'trace-parent' },
      idempotencyKey: 'step_01ABC',
    });

    await expect(task(payload, {} as any)).resolves.toBeUndefined();

    expect(getWorkflowPort).toHaveBeenCalled();
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/.well-known/workflow/v1/flow',
      }),
    ]);
  });

  it('keeps the base-url error when env vars and local port detection cannot resolve a target', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();

    const task = getTaskHandler('workflow_flows');
    const message = {
      runId: 'run_01ABC',
      stepId: 'step_01ABC',
      stepName: 'test-step',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_workflow_test-step', message, {
      idempotencyKey: 'step_01ABC',
    });

    await expect(task(payload, {} as any)).rejects.toThrow(
      'Unable to resolve base URL for workflow queue.'
    );

    expect(getWorkflowPort).toHaveBeenCalled();
  });

  it('keeps Graphile Worker automatic shutdown by default', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

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

    await queue.start();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ noHandleSignals: true })
    );
  });

  it('aborts while waiting for an HTTP response without scheduling a replacement', async () => {
    const server = await startHangingWorkflowHttpServer('headers');
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();

    const controller = new AbortController();
    const execution = getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test-step', {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'test-step',
      }),
      {
        abortSignal: controller.signal,
        job: { attempts: 1 },
      }
    );
    const outcome = execution.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );

    await server.requestReceived;
    controller.abort();

    await expect(settleWithin(outcome)).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ name: 'AbortError' }),
    });
    expect(workerUtilsMock.addJob).not.toHaveBeenCalled();
  });

  it('aborts while reading an HTTP response body without scheduling a replacement', async () => {
    const server = await startHangingWorkflowHttpServer('body');
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const target = new URL(server.baseUrl);
    let resolveResponseReceived!: () => void;
    const responseReceived = new Promise<void>((resolve) => {
      resolveResponseReceived = resolve;
    });
    const responseChannel = channel('http.client.response.finish');
    const onResponse = (message: unknown) => {
      const { request } = message as { request: ClientRequest };
      if (
        request.getHeader('host') === target.host &&
        request.path === '/.well-known/workflow/v1/flow'
      ) {
        resolveResponseReceived();
      }
    };
    responseChannel.subscribe(onResponse);

    try {
      const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
      await queue.start();

      const controller = new AbortController();
      const execution = getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test-step', {
          runId: 'run_01ABC',
          stepId: 'step_01ABC',
          stepName: 'test-step',
        }),
        {
          abortSignal: controller.signal,
          job: { attempts: 1 },
        }
      );
      const outcome = execution.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      );

      await responseReceived;
      // The diagnostic fires before the response event; let its promise
      // continuation enter response.text() before aborting the body read.
      await Promise.resolve();
      controller.abort();

      await expect(settleWithin(outcome)).resolves.toMatchObject({
        status: 'rejected',
        error: expect.objectContaining({ name: 'AbortError' }),
      });
      expect(workerUtilsMock.addJob).not.toHaveBeenCalled();
    } finally {
      responseChannel.unsubscribe(onResponse);
    }
  });

  it.each([
    undefined,
    'custom',
  ])('delivers a wake while the same run is awaiting an inline step (namespace: %s)', async (namespace) => {
    const firstRequestStarted = Promise.withResolvers<void>();
    const releaseFirstRequest = Promise.withResolvers<void>();
    let requestCount = 0;
    const server = await startWorkflowHttpServer([], 0, undefined, async () => {
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestStarted.resolve();
        await releaseFirstRequest.promise;
      }
    });
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace },
      pool
    );
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

  it('does not require a runId for workflow health-check payloads', async () => {
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const server = await startWorkflowHttpServer(requests);
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
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
          method: 'POST',
          headers: expect.objectContaining({
            'x-vqs-queue-name': '__wkf_workflow_health_check',
          }),
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses basePath for local postgres queue HTTP delivery', async () => {
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const port = await getUnusedLoopbackPort();
    await startWorkflowHttpServer(
      requests,
      port,
      '/v2/.well-known/workflow/v1/flow'
    );
    process.env.PORT = String(port);
    setWorkflowBasePath('/v2');

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    try {
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      const payload = buildMessageData('__wkf_workflow_test-step', {
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

  it('defaults pollInterval to 500ms and honors an override from config', async () => {
    const defaultQueue = buildQueue(
      { connectionString: 'postgres://test' },
      pool
    );
    await defaultQueue.start();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ pollInterval: 500 })
    );

    const overriddenQueue = buildQueue(
      { connectionString: 'postgres://test', pollInterval: 2000 },
      pool
    );
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

  it('transfers legacy orchestration before HTTP execution and preserves its retry budget', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    await queue.start();
    const fetchMock = vi
      .spyOn(nodeHttp, 'nodeHttpFetch')
      .mockResolvedValue(Response.json({ ok: true }));
    try {
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
      expect(fetchMock).not.toHaveBeenCalled();
      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows_executor',
        expect.objectContaining({ ...payload, attempt: 4, attemptOffset: 3 }),
        expect.objectContaining({
          queueName: 'workflow_flows:run_a:executor',
          jobKey: `workflow_flows_executor:transfer:${payload.messageId}`,
          maxAttempts: 6,
        })
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('keeps post-ceiling headroom when transferring a job on the default cap', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    await queue.start();
    const fetchMock = vi
      .spyOn(nodeHttp, 'nodeHttpFetch')
      .mockResolvedValue(Response.json({ ok: true }));
    try {
      const payload = buildMessageData('__wkf_workflow_example', {
        runId: 'run_a',
      });
      // Delivery 49 is where core records MAX_DELIVERIES_EXCEEDED. A job with
      // no stored cap takes the default, so the transferred job must still
      // have attempts left for core's post-ceiling redeliveries (73 - 49 + 1).
      await getTaskHandler('workflow_flows')(payload, {
        job: { attempts: 49 },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows_executor',
        expect.objectContaining({ attempt: 49, attemptOffset: 48 }),
        expect.objectContaining({ maxAttempts: 25 })
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('does not acknowledge a legacy transfer when enqueue fails', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
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

  it('only forwards executor provenance for a job on the expected named queue', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    await queue.start();
    process.env.WORKFLOW_LOCAL_BASE_URL = 'http://executor.test';
    const fetchMock = vi
      .spyOn(nodeHttp, 'nodeHttpFetch')
      .mockResolvedValue(Response.json({ ok: true }));
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
    try {
      const execute = getTaskHandler('workflow_flows_executor');
      await execute(payload, helpers);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows_executor',
        expect.anything(),
        expect.objectContaining({ queueName: 'workflow_flows:run_a:executor' })
      );
      helpers.getQueueName.mockResolvedValue('workflow_flows:run_a:executor');
      await execute(payload, helpers);
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
      expect(headers.get('x-workflow-postgres-executor-job')).toBe('42');
      expect(headers.get('x-workflow-postgres-executor-worker')).toBe(
        'worker-real'
      );
      expect(headers.get('x-workflow-postgres-executor-attempt')).toBe('2');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('strips executor provenance from step deliveries', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', enableInvoke: true },
      pool
    );
    await queue.start();
    process.env.WORKFLOW_LOCAL_BASE_URL = 'http://executor.test';
    const fetchMock = vi
      .spyOn(nodeHttp, 'nodeHttpFetch')
      .mockResolvedValue(Response.json({ ok: true }));
    try {
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
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
      expect(headers.has('x-workflow-postgres-executor-job')).toBe(false);
      expect(headers.has('x-workflow-postgres-executor-worker')).toBe(false);
      expect(headers.has('x-workflow-postgres-executor-attempt')).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  function receiver() {
    // Exercise the Postgres wrapper with a minimal local HTTP adapter. The
    // real database suite uses the actual world-local HTTP handler as well.
    createQueueHandler.mockImplementation(
      (_prefix, callback) => async (req) => {
        await callback(await req.json(), {
          attempt: Number(req.headers.get('x-vqs-message-attempt')),
          messageId: MessageId.parse(req.headers.get('x-vqs-message-id')),
          queueName: ValidQueueName.parse(req.headers.get('x-vqs-queue-name')),
        });
        return Response.json({ ok: true });
      }
    );
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
    await expect(receive(request(proof))).rejects.toThrow(
      'not active on the run queue'
    );
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

// Graphile Worker 0.16 ends a worker whose job release fails with an error it
// does not retry (a dropped or refused connection) and never replaces it, so a
// runner left alone loses a worker on every database failover a job finishes
// across, until it claims nothing.
describe('postgres queue lost workers', () => {
  const workerUtilsMock = {
    addJob: vi.fn(),
    migrate: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
  } as any;

  /**
   * A Graphile Worker runner whose events the test emits. Like the real one,
   * stopping it emits `stop` and starts its pool's graceful shutdown.
   */
  function fakeRunner() {
    const events = new EventEmitter();
    return {
      stop: vi.fn(async () => {
        events.emit('stop', {});
        events.emit('pool:gracefulShutdown', {});
      }),
      promise: Promise.resolve() as Promise<void>,
      events,
    };
  }

  /** A fake runner that `fail()` stops the way Graphile Worker does on an error. */
  function failingRunner() {
    const failing = fakeRunner();
    const settled = Promise.withResolvers<void>();
    failing.promise = settled.promise;
    return Object.assign(failing, {
      /** As when the runner's cron fails: it stops, and its promise rejects. */
      fail(error = new Error('Connection terminated unexpectedly')) {
        failing.events.emit('stop', {});
        failing.events.emit('pool:gracefulShutdown', {});
        settled.reject(error);
        return error;
      },
    });
  }

  /** What Graphile Worker emits when a worker fails to release its job. */
  function loseWorker(lost: ReturnType<typeof fakeRunner>, jobId = '7') {
    const error = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' }
    );
    lost.events.emit('worker:fatalError', {
      worker: { workerId: 'worker-1', getActiveJob: () => ({ id: jobId }) },
      error,
      jobError: null,
    });
    return error;
  }

  /** `run()` hands out these runners, in order, then rejects. */
  function runnersInOrder(
    ...runners: Array<
      | ReturnType<typeof fakeRunner>
      | Error
      | Promise<ReturnType<typeof fakeRunner>>
    >
  ) {
    for (const next of runners) {
      if (next instanceof Error) vi.mocked(run).mockRejectedValueOnce(next);
      else
        vi.mocked(run).mockReturnValueOnce(
          Promise.resolve(next) as unknown as Promise<Runner>
        );
    }
  }

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => {
    vi.clearAllMocks();
    // Each test queues its own runners; a start a test cancelled must not
    // hand its runner to the next test.
    vi.mocked(run).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pool.query.mockResolvedValue({ rows: [{ exists: false }] });
    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    vi.mocked(createWorld).mockReturnValue({
      createQueueHandler: vi.fn(() => vi.fn(async () => Response.json({}))),
      close: vi.fn(),
    } as any);
  });

  afterEach(async () => {
    vi.useRealTimers();
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
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    vi.mocked(console.warn).mockRestore();
  });

  it('starts a runner in place of one that lost a worker, and retires the old one once it is up', async () => {
    const first = fakeRunner();
    const second = fakeRunner();
    const secondUp = Promise.withResolvers<ReturnType<typeof fakeRunner>>();
    runnersInOrder(first, secondUp.promise);
    const onWorkerLost = vi.fn();
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost },
      pool
    );
    await queue.start();

    const error = loseWorker(first);
    expect(onWorkerLost).toHaveBeenCalledExactlyOnceWith({
      error,
      workerId: 'worker-1',
      jobId: '7',
    });
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    // Until the new runner is up, the old one's other workers keep claiming.
    expect(first.stop).not.toHaveBeenCalled();

    secondUp.resolve(second);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    // The grace the old runner's jobs would get is the one the queue gives
    // retired runners' deliveries.
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ gracefulShutdownAbortTimeout: 5_000 })
    );
    await queue.close();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('keeps the runner that lost a worker while no replacement can start, retrying after 1s, doubling to 30s', async () => {
    // The release failed because the database is going away, and a new
    // runner needs it to start.
    const first = fakeRunner();
    const second = fakeRunner();
    const attempts: number[] = [];
    vi.mocked(run).mockImplementation(async () => {
      if (vi.mocked(run).mock.calls.length === 1) {
        return first as unknown as Runner;
      }
      attempts.push(Date.now());
      if (attempts.length <= 6) throw new Error('connect ECONNREFUSED');
      return second as unknown as Runner;
    });
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    loseWorker(first);
    await vi.advanceTimersByTimeAsync(60_999);
    expect(first.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(attempts.slice(1).map((at, i) => at - attempts[i])).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
  });

  it('waits for a replacement start that hangs, without starting another, and uses it once it is up', async () => {
    // A runner that came up late beside another would run the jobs its
    // workers had already claimed on top of the other's.
    const first = fakeRunner();
    const second = fakeRunner();
    const slow = Promise.withResolvers<ReturnType<typeof fakeRunner>>();
    runnersInOrder(first, slow.promise);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    loseWorker(first);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(first.stop).not.toHaveBeenCalled();

    slow.resolve(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.stop).toHaveBeenCalledOnce();
  });

  it('replaces a runner once, however many workers it loses', async () => {
    const first = fakeRunner();
    runnersInOrder(first, fakeRunner());
    const onWorkerLost = vi.fn();
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost },
      pool
    );
    await queue.start();

    loseWorker(first, '7');
    loseWorker(first, '8');
    loseWorker(first, '9');
    expect(onWorkerLost).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('replaces replacements that keep losing a worker soon after they start one backoff step apart', async () => {
    // Releases that keep failing while fetches succeed would otherwise start
    // runners, and strand a job with each, as fast as jobs are claimed.
    const runners = [fakeRunner(), fakeRunner(), fakeRunner(), fakeRunner()];
    runnersInOrder(...runners);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'performance'],
    });

    loseWorker(runners[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    loseWorker(runners[1]);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(runners[1].stop).toHaveBeenCalledOnce();

    loseWorker(runners[2]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('replaces a replacement at once when it ran for 30s before losing a worker', async () => {
    const runners = [fakeRunner(), fakeRunner(), fakeRunner()];
    runnersInOrder(...runners);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'performance'],
    });

    loseWorker(runners[0]);
    await vi.advanceTimersByTimeAsync(30_000);
    loseWorker(runners[1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    'stop',
    'pool:gracefulShutdown',
    'pool:forcefulShutdown',
  ])('reports but does not replace a runner that is stopping (%s)', async (stopEvent) => {
    // close(), or Graphile Worker's own shutdown on a signal or a breaking
    // migration, is taking the runner down.
    const first = fakeRunner();
    runnersInOrder(first);
    const onWorkerLost = vi.fn();
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost },
      pool
    );
    await queue.start();

    first.events.emit(stopEvent, {});
    loseWorker(first);
    await flush();
    expect(onWorkerLost).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('gives up a replacement once Graphile Worker stops the old runner itself', async () => {
    const first = fakeRunner();
    runnersInOrder(first, new Error('connect ECONNREFUSED'), fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    loseWorker(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    first.events.emit('pool:gracefulShutdown', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('reporter down');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('reporter down');
      },
    ],
  ])('replaces the runner and warns when onWorkerLost %s', async (_, onWorkerLost) => {
    const first = fakeRunner();
    runnersInOrder(first, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost },
      pool
    );
    await queue.start();

    expect(() => loseWorker(first)).not.toThrow();
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[world-postgres] onWorkerLost failed:',
        expect.objectContaining({ message: 'reporter down' })
      )
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('replaces the runner when Graphile Worker stops it over an error', async () => {
    // As when the crontab query every runner makes at start meets a database
    // that is going away.
    const first = failingRunner();
    runnersInOrder(first, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();

    const error = first.fail();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(console.warn).toHaveBeenCalledWith(
      '[world-postgres] Graphile Worker stopped its runner over an error; starting another:',
      error
    );
  });

  it("leaves a failed runner's deliveries to Graphile Worker's abort", async () => {
    // Graphile Worker is already stopping the runner, and aborts its jobs
    // after the usual grace period.
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/.well-known/workflow/v1/flow',
      () => new Promise<void>(() => {})
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const first = failingRunner();
    runnersInOrder(first, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    const graphileAbort = new AbortController();
    const delivery = getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
      { abortSignal: graphileAbort.signal, job: { attempts: 1 } }
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    first.fail();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    graphileAbort.abort();
    await expect(delivery).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not replace a runner that fails once a signal is shutting the runners down', async () => {
    const first = failingRunner();
    runnersInOrder(first, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();

    first.events.emit('gracefulShutdown', { signal: 'SIGTERM' });
    first.fail();
    await flush();
    expect(run).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalledWith(
      '[world-postgres] Graphile Worker stopped its runner over an error; starting another:',
      expect.anything()
    );
  });

  it('replaces a runner that fails after the replacement its lost worker started gave up on it', async () => {
    // Graphile Worker emits `stop` before the runner's promise rejects, so a
    // replacement under way first takes the stop for a deliberate one.
    const first = failingRunner();
    const discarded = fakeRunner();
    const discardedUp = Promise.withResolvers<ReturnType<typeof fakeRunner>>();
    runnersInOrder(first, discardedUp.promise, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();

    loseWorker(first);
    first.events.emit('stop', {});
    discardedUp.resolve(discarded);
    await vi.waitFor(() => expect(discarded.stop).toHaveBeenCalledOnce());
    first.fail();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  });

  it('lets a delivery on a retired runner finish after Graphile Worker aborts its jobs', async () => {
    // Retiring stops the runner, and Graphile Worker aborts a stopping
    // runner's job signals after its grace period. Aborted, the delivery would
    // lose an attempt and be redelivered while its handler still ran.
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const respond = Promise.withResolvers<void>();
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/.well-known/workflow/v1/flow',
      () => respond.promise
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const first = fakeRunner();
    runnersInOrder(first, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    const graphileAbort = new AbortController();
    const delivery = getTaskHandler('workflow_flows')(
      buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
      { abortSignal: graphileAbort.signal, job: { attempts: 1 } }
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    loseWorker(first);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    graphileAbort.abort();
    respond.resolve();
    await expect(delivery).resolves.toBeUndefined();
  });

  /**
   * Start a delivery the app never answers on the first runner, then retire
   * that runner by losing one of its workers. Graphile Worker's stop waits for
   * the jobs its workers are running, so the retired runner stops only once
   * the delivery ends.
   */
  async function holdDeliveryOnRetiredRunner(
    ...later: Array<ReturnType<typeof fakeRunner>>
  ) {
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const answer = Promise.withResolvers<void>();
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/.well-known/workflow/v1/flow',
      () => answer.promise
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const first = fakeRunner();
    const second = fakeRunner();
    runnersInOrder(first, second, ...later);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    const deliver = (runId: string) =>
      getTaskHandler('workflow_flows')(
        buildMessageData('__wkf_workflow_test', { runId }),
        { abortSignal: new AbortController().signal, job: { attempts: 1 } }
      );
    const ended = deliver('run_01ABC').then(
      () => 'fulfilled' as const,
      (error: unknown) => error
    );
    first.stop.mockImplementation(async () => {
      await ended;
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    loseWorker(first);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    let hasEnded = false;
    void ended.then(() => {
      hasEnded = true;
    });
    return {
      queue,
      active: second,
      ended,
      hasEnded: () => hasEnded,
      deliver,
      answer: () => answer.resolve(),
    };
  }

  it("aborts a retired runner's deliveries once close() has given them the grace period", async () => {
    const { queue, ended, hasEnded, deliver } =
      await holdDeliveryOnRetiredRunner();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = queue.close();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hasEnded()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(ended).resolves.toMatchObject({ name: 'AbortError' });
    // A job one of its workers claims after that is aborted at once.
    await expect(deliver('run_01DEF')).rejects.toMatchObject({
      name: 'AbortError',
    });
    await closing;
  });

  it.each([
    'gracefulShutdown',
    'forcefulShutdown',
  ])("aborts a retired runner's deliveries at once on a signal Graphile Worker handles (%s)", async (signalEvent) => {
    // Graphile Worker's signal handler does not wait for a retired runner, so
    // the process can exit before a grace period would end.
    const { active, ended, deliver } = await holdDeliveryOnRetiredRunner();
    // Frozen: no grace period can pass.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    active.events.emit(signalEvent, { signal: 'SIGTERM' });
    await expect(ended).resolves.toMatchObject({ name: 'AbortError' });
    // A job one of its workers claims after that is aborted at once too.
    await expect(deliver('run_01DEF')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it("lets a retired runner's deliveries run on when Graphile Worker stops the active runner without a signal", async () => {
    // A breaking migration, or the active runner's own failure, stops it
    // without ending the process.
    const { active, ended, hasEnded, answer } =
      await holdDeliveryOnRetiredRunner();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    active.events.emit('stop', {});
    active.events.emit('pool:gracefulShutdown', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hasEnded()).toBe(false);
    vi.useRealTimers();
    answer();
    await expect(ended).resolves.toBe('fulfilled');
  });

  it("gives an older retired runner's deliveries the grace period once a newer runner is retired", async () => {
    // Only the latest retired runner's deliveries run without a time limit.
    const { active, ended, hasEnded } = await holdDeliveryOnRetiredRunner(
      fakeRunner()
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    loseWorker(active);
    // `active` replaced a runner a moment ago, so its replacement waits 1s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(active.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hasEnded()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(ended).resolves.toMatchObject({ name: 'AbortError' });
  });

  it('aborts at once the deliveries of a runner that comes up after a signal', async () => {
    // Its pool can already exist when the signal arrives, so Graphile Worker
    // shuts it down too, and the process exits without waiting for it.
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/.well-known/workflow/v1/flow',
      () => new Promise<void>(() => {})
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const first = fakeRunner();
    const late = fakeRunner();
    const lateUp = Promise.withResolvers<ReturnType<typeof fakeRunner>>();
    runnersInOrder(first, lateUp.promise);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    loseWorker(first);
    first.events.emit('gracefulShutdown', { signal: 'SIGTERM' });
    lateUp.resolve(late);
    await vi.waitFor(() => expect(late.stop).toHaveBeenCalledOnce());

    const lateTask = vi.mocked(run).mock.calls[1]?.[0]?.taskList
      ?.workflow_flows as (payload: unknown, helpers: unknown) => Promise<void>;
    await expect(
      lateTask(
        buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
        {
          abortSignal: new AbortController().signal,
          job: { attempts: 1 },
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('close() waits for a retired runner to finish its jobs before releasing the worker utils', async () => {
    // A job that finishes after the utils are released cannot enqueue its
    // follow-up.
    const first = fakeRunner();
    const firstStopped = Promise.withResolvers<void>();
    first.stop.mockImplementation(() => firstStopped.promise);
    runnersInOrder(first, fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    loseWorker(first);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());

    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    expect(workerUtilsMock.release).not.toHaveBeenCalled();
    firstStopped.resolve();
    await closing;
    expect(workerUtilsMock.release).toHaveBeenCalledOnce();
  });

  it('starts no runner after close(), even with a retry pending', async () => {
    const first = fakeRunner();
    runnersInOrder(first, new Error('connect ECONNREFUSED'), fakeRunner());
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    loseWorker(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    await queue.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('close() stops the active runner, then retires a replacement still starting', async () => {
    const first = fakeRunner();
    const second = fakeRunner();
    const secondUp = Promise.withResolvers<ReturnType<typeof fakeRunner>>();
    runnersInOrder(first, secondUp.promise);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    loseWorker(first);

    const closing = queue.close();
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    // After close()'s own steps have run, so a close() that does not wait
    // for the replacement has already returned.
    setImmediate(() => secondUp.resolve(second));
    await closing;
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('aborts the deliveries of a runner retired during close() once the grace period passes', async () => {
    // A replacement that comes up after close() began is retired at once, but
    // its workers can already have claimed jobs.
    const requests: Parameters<typeof startWorkflowHttpServer>[0] = [];
    const server = await startWorkflowHttpServer(
      requests,
      0,
      '/.well-known/workflow/v1/flow',
      () => new Promise<void>(() => {})
    );
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;
    const first = fakeRunner();
    const late = fakeRunner();
    const lateUp = Promise.withResolvers<ReturnType<typeof fakeRunner>>();
    runnersInOrder(first, lateUp.promise);
    const queue = buildQueue(
      { connectionString: 'postgres://test', onWorkerLost: vi.fn() },
      pool
    );
    await queue.start();
    loseWorker(first);
    const closing = queue.close();
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());

    const lateTask = vi.mocked(run).mock.calls[1]?.[0]?.taskList
      ?.workflow_flows as (payload: unknown, helpers: unknown) => Promise<void>;
    const ended = lateTask(
      buildMessageData('__wkf_workflow_test', { runId: 'run_01ABC' }),
      { abortSignal: new AbortController().signal, job: { attempts: 1 } }
    ).then(
      () => 'fulfilled' as const,
      (error: unknown) => error
    );
    let hasEnded = false;
    void ended.then(() => {
      hasEnded = true;
    });
    late.stop.mockImplementation(async () => {
      await ended;
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    lateUp.resolve(late);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(late.stop).toHaveBeenCalledOnce();
    expect(hasEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(ended).resolves.toMatchObject({ name: 'AbortError' });
    await closing;
  });
});

function buildQueue(
  config: Parameters<typeof createQueue>[0],
  pgPool: Parameters<typeof createQueue>[1]
) {
  const queue = createQueue(config, pgPool);
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
  }
) {
  const { id } = parseQueueName(queueName);

  return MessageData.encode({
    id,
    data: transport.serialize(payload),
    attempt: opts?.attempt ?? 1,
    headers: opts?.headers,
    idempotencyKey: opts?.idempotencyKey,
    messageId: opts?.messageId ?? MessageId.parse('msg_01ABC'),
  });
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
  beforeResponse?: () => Promise<void>
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
      res.end(JSON.stringify({ ok: true }));
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

async function startHangingWorkflowHttpServer(stage: 'headers' | 'body') {
  let resolveRequestReceived!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequestReceived = resolve;
  });
  const server = createServer((req, res) => {
    req.resume();
    resolveRequestReceived();

    if (stage === 'body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  createdServers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine test server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestReceived,
  };
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 250
): Promise<T | { status: 'pending' }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<{ status: 'pending' }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: 'pending' }), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function getUnusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  if (!address || typeof address === 'string') {
    throw new Error('Failed to reserve a loopback port');
  }

  return address.port;
}
