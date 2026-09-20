import { channel } from 'node:diagnostics_channel';
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
          maxAttempts: 49,
          runAt: new Date('2024-01-01T00:00:05.000Z'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
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
        maxAttempts: 49,
      })
    );
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
