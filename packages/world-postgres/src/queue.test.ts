import assert from 'node:assert/strict';
import { JsonTransport } from '@vercel/queue';
import { setWorkflowBasePath } from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import { MessageId, parseQueueName, type QueuePayload } from '@workflow/world';
import { makeWorkerUtils, run, type WorkerUtils } from 'graphile-worker';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageData } from './message.js';
import { createQueue } from './queue.js';

const transport = new JsonTransport();
const queues: ReturnType<typeof createQueue>[] = [];
type QueueHandler = Parameters<
  ReturnType<typeof createQueue>['createQueueHandler']
>[1];

vi.mock('graphile-worker', () => ({
  Logger: class Logger {},
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

describe('Postgres queue', () => {
  const workerUtils = {
    addJob: vi.fn(),
    migrate: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const runner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
  const query = vi.fn(async () => ({ rows: [{ exists: false }] }));
  const pool = { query } as unknown as Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtils);
    vi.mocked(run).mockResolvedValue(runner);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    query.mockImplementation(async () => ({
      rows: [{ exists: false }],
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setWorkflowBasePath(undefined);
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
  });

  it('starts one runner with workflow and step tasks', async () => {
    const queue = buildQueue(pool);

    await Promise.all([queue.start(), queue.start()]);

    expect(makeWorkerUtils).toHaveBeenCalledTimes(1);
    expect(workerUtils.migrate).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]?.[0].taskList).toEqual({
      workflow_flows: expect.any(Function),
      workflow_steps: expect.any(Function),
    });
  });

  it('propagates runner startup failures and retries the next start', async () => {
    vi.mocked(run).mockRejectedValueOnce(new Error('runner failed'));
    const queue = buildQueue(pool);

    await expect(
      queue.queue('__wkf_workflow_test', { runId: 'wrun_01ABC' })
    ).rejects.toThrow('runner failed');
    expect(workerUtils.addJob).not.toHaveBeenCalled();
    expect(workerUtils.release).toHaveBeenCalledTimes(1);

    await queue.queue('__wkf_workflow_test', { runId: 'wrun_01ABC' });

    expect(run).toHaveBeenCalledTimes(2);
    expect(workerUtils.addJob).toHaveBeenCalledTimes(1);
  });

  it('waits for pending startup before closing', async () => {
    let finishRun!: (value: Awaited<ReturnType<typeof run>>) => void;
    vi.mocked(run).mockReturnValue(
      new Promise((resolve) => {
        finishRun = resolve;
      })
    );
    const queue = buildQueue(pool);
    const start = queue.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    const close = queue.close();
    expect(workerUtils.release).not.toHaveBeenCalled();
    finishRun(runner);
    await Promise.all([start, close]);

    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(workerUtils.release).toHaveBeenCalledTimes(1);
  });

  it('rejects operations after close', async () => {
    const queue = buildQueue(pool);
    await queue.close();

    await expect(queue.start()).rejects.toThrow('Postgres queue is closed');
    await expect(
      queue.queue('__wkf_workflow_test', { runId: 'wrun_01ABC' })
    ).rejects.toThrow('Postgres queue is closed');
    expect(() =>
      queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    ).toThrow('Postgres queue is closed');
  });

  it('adds messages with their durable delivery options', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const queue = buildQueue(pool);

    const { messageId } = await queue.queue(
      '__wkf_workflow_test-workflow',
      { runId: 'wrun_01ABC' },
      {
        delaySeconds: 5,
        headers: { traceparent: 'trace-parent' },
        idempotencyKey: 'wrun_01ABC',
      }
    );

    expect(workerUtils.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({
        attempt: 1,
        headers: { traceparent: 'trace-parent' },
        id: 'test-workflow',
        idempotencyKey: 'wrun_01ABC',
        messageId,
      }),
      {
        jobKey: 'wrun_01ABC',
        maxAttempts: 3,
        runAt: new Date('2024-01-01T00:00:05.000Z'),
      }
    );
  });

  it('executes a registered step handler without a workflow handler', async () => {
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_step_', handler);
    await queue.start();

    await getTask('workflow_steps')(
      buildMessageData('__wkf_step_test-step', stepMessage()),
      jobHelpers(1)
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('loads a lazy route before durably deferring', async () => {
    vi.mocked(getWorkflowPort).mockResolvedValue(3000);
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue(pool);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        'http://localhost:3000/.well-known/workflow/v1/flow?__health'
      );
      queue.createQueueHandler('__wkf_workflow_', handler);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await queue.start();

    await getTask('workflow_flows')(
      buildMessageData('__wkf_workflow_test-workflow', {
        runId: 'wrun_01ABC',
      }),
      jobHelpers(1)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(workerUtils.addJob).not.toHaveBeenCalled();
  });

  it('durably defers a delivery while no executor is available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const queue = buildQueue(pool);
    await queue.start();
    const payload = buildMessageData(
      '__wkf_workflow_test-workflow',
      { runId: 'wrun_01ABC' },
      { attempt: 2 }
    );

    await getTask('workflow_flows')(payload, jobHelpers(2));

    expect(workerUtils.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({ attempt: 3 }),
      expect.objectContaining({
        maxAttempts: 3,
        runAt: new Date('2024-01-01T00:00:01.000Z'),
      })
    );
  });

  it('combines persisted and Graphile attempts', async () => {
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();

    await getTask('workflow_flows')(
      buildMessageData(
        '__wkf_workflow_test-workflow',
        { runId: 'wrun_01ABC' },
        { attempt: 2 }
      ),
      jobHelpers(2)
    );

    expect(handler).toHaveBeenCalledWith(
      { runId: 'wrun_01ABC' },
      expect.objectContaining({ attempt: 3 })
    );
  });

  it('preserves the logical attempt across timeout replacement jobs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const handler = vi
      .fn<QueueHandler>()
      .mockResolvedValueOnce({ timeoutSeconds: 5 })
      .mockResolvedValueOnce(undefined);
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_step_', handler);
    await queue.start();
    const task = getTask('workflow_steps');

    await task(
      buildMessageData('__wkf_step_test-step', stepMessage()),
      jobHelpers(1)
    );
    const replacement = vi.mocked(workerUtils.addJob).mock.calls[0]?.[1];
    assert(replacement);
    await task(replacement, jobHelpers(1));

    expect(handler.mock.calls.map(([, metadata]) => metadata.attempt)).toEqual([
      1, 2,
    ]);
    expect(workerUtils.addJob).toHaveBeenCalledWith(
      'workflow_steps',
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({
        runAt: new Date('2024-01-01T00:00:05.000Z'),
      })
    );
  });

  it('rejects invalid timeout results', async () => {
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_step_', async () => ({
      timeoutSeconds: -1,
    }));
    await queue.start();

    await expect(
      getTask('workflow_steps')(
        buildMessageData('__wkf_step_test-step', stepMessage()),
        jobHelpers(1)
      )
    ).rejects.toThrow();
    expect(workerUtils.addJob).not.toHaveBeenCalled();
  });

  it('uses the explicit remote HTTP executor', async () => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const fetchMock = vi.fn(async (url: string) => {
      return url.endsWith('?__health')
        ? new Response(null, { status: 200 })
        : Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const queue = buildQueue(pool);
    await queue.start();
    const messageId = MessageId.parse('msg_01ABC');

    await getTask('workflow_flows')(
      buildMessageData(
        '__wkf_workflow_test-workflow',
        { runId: 'wrun_01ABC' },
        { messageId }
      ),
      jobHelpers(2)
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example.test/.well-known/workflow/v1/flow',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-vqs-message-attempt': '2',
          'x-vqs-message-id': messageId,
          'x-vqs-queue-name': '__wkf_workflow_test-workflow',
        }),
        method: 'POST',
      })
    );
  });

  it.each([
    { wat: true },
    { ok: true, timeoutSeconds: 5 },
    { timeoutSeconds: -1 },
  ])('rejects invalid remote responses', async (body) => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('?__health')
          ? new Response(null, { status: 200 })
          : Response.json(body)
      )
    );
    const queue = buildQueue(pool);
    await queue.start();

    await expect(
      getTask('workflow_flows')(
        buildMessageData('__wkf_workflow_test-workflow', {
          runId: 'wrun_01ABC',
        }),
        jobHelpers(1)
      )
    ).rejects.toThrow();
  });

  it('prefers a direct handler over the remote fallback', async () => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();

    await getTask('workflow_flows')(
      buildMessageData('__wkf_workflow_test-workflow', {
        runId: 'wrun_01ABC',
      }),
      jobHelpers(1)
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an HTTP-compatible queue handler', async () => {
    const handler = vi.fn(async () => ({ timeoutSeconds: 5 }));
    const queue = buildQueue(pool);
    const route = queue.createQueueHandler('__wkf_workflow_', handler);
    const messageId = MessageId.parse('msg_01ABC');

    const response = await route(
      new Request('http://localhost/.well-known/workflow/v1/flow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vercel-id': 'iad1::request-id',
          'x-vqs-message-attempt': '3',
          'x-vqs-message-id': messageId,
          'x-vqs-queue-name': '__wkf_workflow_test-workflow',
        },
        body: transport.serialize({ runId: 'wrun_01ABC' }),
      })
    );

    await expect(response.json()).resolves.toEqual({ timeoutSeconds: 5 });
    expect(handler).toHaveBeenCalledWith(
      { runId: 'wrun_01ABC' },
      {
        attempt: 3,
        messageId,
        queueName: '__wkf_workflow_test-workflow',
        requestId: 'iad1::request-id',
      }
    );
  });

  it('rejects malformed HTTP queue requests', async () => {
    const queue = buildQueue(pool);
    const route = queue.createQueueHandler(
      '__wkf_workflow_',
      async () => undefined
    );

    const response = await route(
      new Request('http://localhost/.well-known/workflow/v1/flow', {
        method: 'POST',
        body: '{}',
      })
    );

    expect(response.status).toBe(400);
  });

  it('coalesces concurrent idempotent deliveries', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => released);
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_step_', handler);
    await queue.start();
    const task = getTask('workflow_steps');
    const first = task(
      buildMessageData('__wkf_step_test-step', stepMessage(), {
        idempotencyKey: 'step_01ABC',
        messageId: MessageId.parse('msg_01ABC'),
      }),
      jobHelpers(1)
    );
    const second = task(
      buildMessageData('__wkf_step_test-step', stepMessage(), {
        idempotencyKey: 'step_01ABC',
        messageId: MessageId.parse('msg_01ABD'),
      }),
      jobHelpers(1)
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('remembers completed idempotent deliveries', async () => {
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_step_', handler);
    await queue.start();
    const task = getTask('workflow_steps');
    const payload = buildMessageData('__wkf_step_test-step', stepMessage(), {
      idempotencyKey: 'step_01ABC',
    });

    await task(payload, jobHelpers(1));
    await task(payload, jobHelpers(2));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('serializes workflow deliveries for the same run', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const handler = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (handler.mock.calls.length === 1) await firstReleased;
      active--;
    });
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();
    const task = getTask('workflow_flows');
    const first = task(
      buildMessageData('__wkf_workflow_test', { runId: 'wrun_01ABC' }),
      jobHelpers(1)
    );
    const second = task(
      buildMessageData(
        '__wkf_workflow_test',
        { runId: 'wrun_01ABC' },
        { messageId: MessageId.parse('msg_01ABD') }
      ),
      jobHelpers(1)
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('restores the previous handler when the latest owner closes', async () => {
    const firstHandler = vi.fn(async () => undefined);
    const secondHandler = vi.fn(async () => undefined);
    const firstQueue = buildQueue(pool);
    const secondQueue = buildQueue(pool);
    firstQueue.createQueueHandler('__wkf_workflow_', firstHandler);
    secondQueue.createQueueHandler('__wkf_workflow_', secondHandler);
    await firstQueue.start();
    const task = getTask('workflow_flows');
    const payload = buildMessageData('__wkf_workflow_test', {
      runId: 'wrun_01ABC',
    });

    await task(payload, jobHelpers(1));
    await secondQueue.close();
    await task(payload, jobHelpers(1));

    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(firstHandler).toHaveBeenCalledTimes(1);
  });

  it('uses queue namespaces, job prefixes, and base paths', async () => {
    vi.mocked(getWorkflowPort).mockResolvedValue(3000);
    setWorkflowBasePath('/v2');
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const queue = buildQueue(pool, {
      jobPrefix: 'custom_',
      namespace: 'custom',
    });
    await queue.start();

    await getTask('custom_flows')(
      buildMessageData('__custom_wkf_workflow_test', {
        runId: 'wrun_01ABC',
      }),
      jobHelpers(1)
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/v2/.well-known/workflow/v1/flow?__health',
      expect.objectContaining({ method: 'POST' })
    );
    expect(workerUtils.addJob).toHaveBeenCalledWith(
      'custom_flows',
      expect.objectContaining({ attempt: 1 }),
      expect.any(Object)
    );
  });

  it('migrates staged pg-boss jobs before starting the runner', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            data: { runId: 'wrun_01ABC' },
            name: 'workflow_flows',
            retry_limit: 7,
            singleton_key: 'wrun_01ABC',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const queue = buildQueue(pool);

    await queue.start();

    expect(workerUtils.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      { runId: 'wrun_01ABC' },
      { jobKey: 'wrun_01ABC', maxAttempts: 7 }
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

function buildQueue(
  pool: Pool,
  config: { jobPrefix?: string; namespace?: string } = {}
) {
  const queue = createQueue(
    { connectionString: 'postgres://test', ...config },
    pool
  );
  queues.push(queue);
  return queue;
}

type TestTask = (
  payload: unknown,
  helpers: { job: { attempts: number } }
) => Promise<unknown>;

function getTask(name: string): TestTask {
  const task = vi.mocked(run).mock.calls[0]?.[0].taskList?.[name];
  assert(task);
  return task as TestTask;
}

function jobHelpers(attempts: number) {
  return { job: { attempts } };
}

function stepMessage(): QueuePayload {
  return {
    workflowName: 'test-workflow',
    workflowRunId: 'run_01ABC',
    workflowStartedAt: Date.now(),
    stepId: 'step_01ABC',
  };
}

function buildMessageData(
  queueName: string,
  message: QueuePayload,
  options: {
    attempt?: number;
    headers?: Record<string, string>;
    idempotencyKey?: string;
    messageId?: MessageId;
  } = {}
) {
  const { id } = parseQueueName(queueName);
  return MessageData.encode({
    attempt: options.attempt ?? 1,
    data: transport.serialize(message),
    headers: options.headers,
    id,
    idempotencyKey: options.idempotencyKey,
    messageId: options.messageId ?? MessageId.parse('msg_01ABC'),
  });
}
