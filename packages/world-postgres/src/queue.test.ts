import { createServer, type Server } from 'node:http';
import { JsonTransport } from '@vercel/queue';
import { setWorkflowBasePath } from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import { MessageId, parseQueueName, type QueuePayload } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import {
  makeWorkerUtils,
  type Runner,
  run,
  type WorkerUtils,
} from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageData } from './message.js';
import { createQueue } from './queue.js';

const transport = new JsonTransport();
const DEFAULT_IDEMPOTENCY_QUEUE =
  'workflow_idempotency_9d70a9b47b31ee4a598d79d3949545c491ca35b9fb2aed6b7ac8bdc277f09df3_1a5';
const PREFIXED_IDEMPOTENCY_QUEUE =
  'workflow_idempotency_4ed3ab71b053166eab6696d23bd4b98bba01573451cf7fbad1c531a9460e716b_1a5';
const createdQueues: Array<ReturnType<typeof createQueue>> = [];
const createdServers: Server[] = [];

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
  const createQueueHandler = vi.fn(() => wrappedHandler);
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();

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
    setWorkflowBasePath(undefined);
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
    const nativeFetch = globalThis.fetch;
    let resolveResponseReceived!: () => void;
    const responseReceived = new Promise<void>((resolve) => {
      resolveResponseReceived = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: Parameters<typeof fetch>) => {
        const response = await nativeFetch(...args);
        resolveResponseReceived();
        return response;
      })
    );

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
      // Let executeMessageOverHttp enter response.text() before aborting.
      await Promise.resolve();
      controller.abort();

      await expect(settleWithin(outcome)).resolves.toMatchObject({
        status: 'rejected',
        error: expect.objectContaining({ name: 'AbortError' }),
      });
      expect(workerUtilsMock.addJob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serializes workflow queue execution for the same runId', async () => {
    let resolveFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      resolveFirstRequestStarted = resolve;
    });
    let resolveReleaseFirstRequest!: () => void;
    const releaseFirstRequest = new Promise<void>((resolve) => {
      resolveReleaseFirstRequest = resolve;
    });
    let requestCount = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      if (requestCount === 1) {
        resolveFirstRequestStarted();
        await releaseFirstRequest;
      }

      activeRequests -= 1;
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.WORKFLOW_LOCAL_BASE_URL = 'https://workflow.example.test';

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    try {
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      const payload = {
        runId: 'wrun_01ABC',
      };
      const firstExecution = task(
        buildMessageData('__wkf_workflow_test-workflow', payload, {
          messageId: MessageId.parse('msg_01ABC'),
        }),
        {} as any
      );
      const secondExecution = task(
        buildMessageData('__wkf_workflow_test-workflow', payload, {
          messageId: MessageId.parse('msg_01ABD'),
        }),
        {} as any
      );

      await firstRequestStarted;
      await Promise.resolve();
      expect(requestCount).toBe(1);
      expect(maxActiveRequests).toBe(1);

      resolveReleaseFirstRequest();
      await Promise.all([firstExecution, secondExecution]);

      expect(requestCount).toBe(2);
      expect(maxActiveRequests).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serializes namespaced workflow queue execution for the same runId', async () => {
    let resolveFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      resolveFirstRequestStarted = resolve;
    });
    let resolveReleaseFirstRequest!: () => void;
    const releaseFirstRequest = new Promise<void>((resolve) => {
      resolveReleaseFirstRequest = resolve;
    });
    let requestCount = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      if (requestCount === 1) {
        resolveFirstRequestStarted();
        await releaseFirstRequest;
      }

      activeRequests -= 1;
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.WORKFLOW_LOCAL_BASE_URL = 'https://workflow.example.test';

    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace: 'custom' },
      pool
    );
    try {
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      const payload = {
        runId: 'wrun_01ABC',
      };
      const firstExecution = task(
        buildMessageData('__custom_wkf_workflow_test-workflow', payload, {
          messageId: MessageId.parse('msg_01ABC'),
        }),
        {} as any
      );
      const secondExecution = task(
        buildMessageData('__custom_wkf_workflow_test-workflow', payload, {
          messageId: MessageId.parse('msg_01ABD'),
        }),
        {} as any
      );

      await firstRequestStarted;
      await Promise.resolve();
      expect(requestCount).toBe(1);
      expect(maxActiveRequests).toBe(1);

      resolveReleaseFirstRequest();
      await Promise.all([firstExecution, secondExecution]);

      expect(requestCount).toBe(2);
      expect(maxActiveRequests).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not require a runId for workflow health-check payloads', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.WORKFLOW_LOCAL_BASE_URL = 'https://workflow.example.test';

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    try {
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      const payload = buildMessageData('__wkf_workflow_health_check', {
        __healthCheck: true,
        correlationId: 'hc_01ABC',
      });

      await expect(task(payload, {} as any)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://workflow.example.test/.well-known/workflow/v1/flow',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-vqs-queue-name': '__wkf_workflow_health_check',
          }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses basePath for local postgres queue HTTP delivery', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const port = await getUnusedLoopbackPort();
    await startWorkflowHttpServer([], port);
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

      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:${port}/v2/.well-known/workflow/v1/flow`,
        expect.objectContaining({ method: 'POST' })
      );
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
          queueName: DEFAULT_IDEMPOTENCY_QUEUE,
          runAt: new Date('2024-01-01T00:00:05.000Z'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps delayed retries on the same idempotency queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const fetchMock = vi.fn(async () => Response.json({ timeoutSeconds: 300 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.WORKFLOW_LOCAL_BASE_URL = 'https://workflow.example.test';

    try {
      const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
      await queue.start();

      const task = getTaskHandler('workflow_flows');
      await task(
        buildMessageData(
          '__wkf_workflow_test-step',
          {
            runId: 'run_01ABC',
            stepId: 'step_01ABC',
            stepName: 'test-step',
          },
          { idempotencyKey: 'step_01ABC' }
        ),
        { job: { attempts: 1 } }
      );

      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_flows',
        expect.objectContaining({
          attempt: 2,
          idempotencyKey: 'step_01ABC',
        }),
        expect.objectContaining({
          jobKey: 'step_01ABC',
          maxAttempts: 49,
          queueName: DEFAULT_IDEMPOTENCY_QUEUE,
          runAt: new Date('2024-01-01T00:05:00.000Z'),
        })
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('does not assign an idempotency queue to unkeyed messages', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    await queue.start();

    await queue.queue('__wkf_workflow_test-workflow', {
      runId: 'run_01ABC',
    });

    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.anything(),
      expect.not.objectContaining({ queueName: expect.anything() })
    );
  });

  it('scopes idempotency queues to the configured job prefix', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', jobPrefix: 'billing_' },
      pool
    );
    await queue.start();

    await queue.queue(
      '__wkf_workflow_test-step',
      {
        runId: 'run_01ABC',
        stepId: 'step_01ABC',
        stepName: 'test-step',
      },
      { idempotencyKey: 'step_01ABC' }
    );

    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'billing_flows',
      expect.anything(),
      expect.objectContaining({
        queueName: PREFIXED_IDEMPOTENCY_QUEUE,
      })
    );
  });

  it('assigns idempotency queues to migrated keyed jobs', async () => {
    const migrationPool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({
          rows: [
            {
              name: 'workflow_flows',
              data: buildMessageData(
                '__wkf_workflow_test-step',
                {
                  runId: 'run_01ABC',
                  stepId: 'step_01ABC',
                  stepName: 'test-step',
                },
                { idempotencyKey: 'step_01ABC' }
              ),
              singleton_key: 'step_01ABC',
              retry_limit: 3,
            },
            {
              name: 'workflow_flows',
              data: buildMessageData('__wkf_workflow_test-workflow', {
                runId: 'run_01ABD',
              }),
              singleton_key: 'msg_01ABC',
              retry_limit: 3,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Parameters<typeof createQueue>[1];
    const queue = buildQueue(
      { connectionString: 'postgres://test' },
      migrationPool
    );

    await queue.start();

    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({
        id: 'test-step',
        idempotencyKey: 'step_01ABC',
      }),
      {
        jobKey: 'step_01ABC',
        maxAttempts: 49,
        queueName: DEFAULT_IDEMPOTENCY_QUEUE,
      }
    );
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({
        id: 'test-workflow',
        idempotencyKey: undefined,
      }),
      expect.not.objectContaining({ queueName: expect.anything() })
    );
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
        queueName: DEFAULT_IDEMPOTENCY_QUEUE,
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
  port = 0
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

    if (req.method === 'POST' && req.url === '/.well-known/workflow/v1/flow') {
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
