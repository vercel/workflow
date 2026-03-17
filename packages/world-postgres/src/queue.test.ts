import { createServer, type Server } from 'node:http';
import { JsonTransport } from '@vercel/queue';
import { getWorkflowPort } from '@workflow/utils/get-port';
import { MessageId, type QueuePayload } from '@workflow/world';
import { makeWorkerUtils, run, type WorkerUtils } from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorld, createQueueExecutor } from '@workflow/world-local';
import { stepEntrypoint } from '../../core/dist/runtime/step-handler.js';
import { createQueue } from './queue.js';
import { MessageData } from './message.js';

const transport = new JsonTransport();
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
    createLocalWorld: vi.fn(actual.createLocalWorld),
    createQueueExecutor: vi.fn(actual.createQueueExecutor),
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
  };
  const executeMessage = vi.fn();
  const registerHandler = vi.fn();
  const executorClose = vi.fn();
  const wrappedHandler = vi.fn(async () => Response.json({ ok: true }));
  const localWorldClose = vi.fn();
  const createQueueHandler = vi.fn(() => wrappedHandler);
  const postgres = vi.fn(async () => [{ exists: false }]) as any;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(runnerMock as any);
    vi.mocked(createQueueExecutor).mockReturnValue({
      executeMessage,
      registerHandler,
      close: executorClose,
    } as any);
    vi.mocked(createLocalWorld).mockReturnValue({
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
          })
      )
    );
    vi.useRealTimers();
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    delete process.env.PORT;
  });

  it('uses the workflow http step route when the real runtime step handler would fail in-process with Step not found', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await startWorkflowHttpServer(requests);
    process.env.WORKFLOW_LOCAL_BASE_URL = server.baseUrl;

    const directHandlers = new Map<
      string,
      (req: Request) => Promise<Response>
    >();
    registerHandler.mockImplementation((prefix, handler) => {
      directHandlers.set(prefix, handler);
    });
    executeMessage.mockImplementation(
      async ({ queueName, messageId, attempt, body, headers }) => {
        const prefix = queueName.startsWith('__wkf_step_')
          ? '__wkf_step_'
          : '__wkf_workflow_';
        const pathname = prefix === '__wkf_step_' ? 'step' : 'flow';
        const handler = directHandlers.get(prefix);
        if (!handler) {
          return { type: 'completed' };
        }

        const response = await handler(
          new Request(`http://localhost/.well-known/workflow/v1/${pathname}`, {
            method: 'POST',
            headers: {
              ...headers,
              'content-type': 'application/json',
              'x-vqs-queue-name': queueName,
              'x-vqs-message-id': messageId,
              'x-vqs-message-attempt': String(attempt),
            },
            body,
          })
        );
        const text = await response.text();

        if (!response.ok) {
          return {
            type: 'error',
            status: response.status,
            text,
            headers: Object.fromEntries(response.headers.entries()),
          };
        }

        try {
          const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
          if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
            return { type: 'reschedule', timeoutSeconds };
          }
        } catch {}

        return { type: 'completed' };
      }
    );
    createQueueHandler.mockImplementation((queuePrefix) => {
      if (queuePrefix === '__wkf_step_') {
        return stepEntrypoint;
      }
      return wrappedHandler;
    });

    const queue = buildQueue({ connectionString: 'postgres://test' }, postgres);

    // Regression for #1416: when the worker process has a real step route
    // loaded but no matching step registration, beta.44 direct execution fails
    // with `Step "..." not found` instead of using the healthy HTTP route.
    queue.createQueueHandler(
      '__wkf_step_',
      vi.fn(async () => undefined)
    );
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const message = {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_step_test-step', message, {
      headers: { traceparent: 'trace-parent' },
      idempotencyKey: 'step_01ABC',
    });

    await expect(task(payload, {} as any)).resolves.toBeUndefined();

    expect(requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/.well-known/workflow/v1/step',
        headers: expect.objectContaining({
          'x-vqs-queue-name': '__wkf_step_test-step',
          'x-vqs-message-attempt': '1',
          traceparent: 'trace-parent',
        }),
      }),
    ]);
  });

  it('uses a late-detected local port when the queue starts before PORT is available', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await startWorkflowHttpServer(requests);
    vi.mocked(getWorkflowPort).mockResolvedValue(
      Number(new URL(server.baseUrl).port)
    );

    const queue = buildQueue({ connectionString: 'postgres://test' }, postgres);
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const message = {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_step_test-step', message, {
      headers: { traceparent: 'trace-parent' },
      idempotencyKey: 'step_01ABC',
    });

    await expect(task(payload, {} as any)).resolves.toBeUndefined();

    expect(getWorkflowPort).toHaveBeenCalled();
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/.well-known/workflow/v1/step',
      }),
    ]);
  });

  it('keeps the base-url error when env vars and local port detection cannot resolve a target', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, postgres);
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const message = {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_step_test-step', message, {
      idempotencyKey: 'step_01ABC',
    });

    await expect(task(payload, {} as any)).rejects.toThrow(
      'Unable to resolve base URL for workflow queue.'
    );

    expect(getWorkflowPort).toHaveBeenCalled();
  });

  it('queues producer delays and headers in graphile job metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    try {
      const queue = buildQueue(
        { connectionString: 'postgres://test' },
        postgres
      );
      await queue.start();

      await queue.queue(
        '__wkf_step_test-step',
        {
          workflowName: 'test-workflow',
          workflowRunId: 'run_01ABC',
          workflowStartedAt: Date.now(),
          stepId: 'step_01ABC',
        },
        {
          delaySeconds: 5,
          headers: { traceparent: 'trace-parent' },
          idempotencyKey: 'step_01ABC',
        }
      );

      expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
        'workflow_steps',
        expect.objectContaining({
          attempt: 1,
          headers: { traceparent: 'trace-parent' },
          id: 'test-step',
          idempotencyKey: 'step_01ABC',
        }),
        expect.objectContaining({
          jobKey: 'step_01ABC',
          maxAttempts: 3,
          runAt: new Date('2024-01-01T00:00:05.000Z'),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function buildQueue(
  config: Parameters<typeof createQueue>[0],
  postgres: Parameters<typeof createQueue>[1]
) {
  const queue = createQueue(config, postgres);
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
  const [, id] = queueName.startsWith('__wkf_step_')
    ? ['__wkf_step_', queueName.slice('__wkf_step_'.length)]
    : ['__wkf_workflow_', queueName.slice('__wkf_workflow_'.length)];

  return MessageData.encode({
    id,
    data: transport.serialize(payload),
    attempt: opts?.attempt ?? 1,
    headers: opts?.headers,
    idempotencyKey: opts?.idempotencyKey,
    messageId: opts?.messageId ?? MessageId.parse('msg_01ABC'),
  });
}

function getTaskHandler(name: 'workflow_flows' | 'workflow_steps') {
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
  }>
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

    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });

    if (req.method === 'POST' && req.url === '/.well-known/workflow/v1/step') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
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
  };
}
