import { JsonTransport } from '@vercel/queue';
import { getWorkflowPort } from '@workflow/utils/get-port';
import { MessageId, parseQueueName, type QueuePayload } from '@workflow/world';
import { makeWorkerUtils, run, type WorkerUtils } from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageData } from './message.js';
import { createQueue } from './queue.js';

const transport = new JsonTransport();
const createdQueues: Array<ReturnType<typeof createQueue>> = [];

vi.mock('graphile-worker', () => ({
  Logger: class Logger {},
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

describe('postgres queue direct execution', () => {
  const workerUtilsMock = {
    addJob: vi.fn(),
    migrate: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const runnerMock = {
    stop: vi.fn(),
  } as Awaited<ReturnType<typeof run>>;
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
  } as any;

  beforeEach(() => {
    vi.mocked(workerUtilsMock.addJob).mockReset();
    vi.mocked(workerUtilsMock.migrate).mockReset();
    vi.mocked(workerUtilsMock.release).mockReset();
    vi.mocked(makeWorkerUtils).mockReset();
    vi.mocked(run).mockReset();
    vi.mocked(getWorkflowPort).mockReset();
    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(run).mockResolvedValue(runnerMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await Promise.all(createdQueues.splice(0).map((queue) => queue.close()));
  });

  it('does not start consuming Graphile jobs before a handler is registered', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await queue.start();

    expect(makeWorkerUtils).toHaveBeenCalled();
    expect(workerUtilsMock.migrate).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await queue.start();

    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
    });
  });

  it('does not start consuming Graphile jobs before startup finishes', async () => {
    let finishMigration!: () => void;
    const migrationFinished = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    vi.mocked(workerUtilsMock.migrate).mockReturnValue(migrationFinished);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    const startPromise = queue.start();
    await vi.waitFor(() => {
      expect(workerUtilsMock.migrate).toHaveBeenCalled();
    });
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(run).not.toHaveBeenCalled();

    finishMigration();
    await startPromise;

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('probes workflow routes to bootstrap handler registration', async () => {
    vi.mocked(getWorkflowPort).mockResolvedValue(3000);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/flow?__health')) {
        queue.createQueueHandler('__wkf_workflow_', async () => undefined);
      }
      if (url.endsWith('/step?__health')) {
        queue.createQueueHandler('__wkf_step_', async () => undefined);
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await queue.start();

    await vi.waitFor(() => {
      expect(vi.mocked(run).mock.calls.at(-1)?.[0]?.taskList).toEqual({
        workflow_flows: expect.any(Function),
        workflow_steps: expect.any(Function),
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/.well-known/workflow/v1/flow?__health',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/.well-known/workflow/v1/step?__health',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('waits for pending route registration before closing', async () => {
    vi.mocked(getWorkflowPort).mockResolvedValue(3000);
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          resolveStarted();
          return new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          });
        })
      );
    });
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await queue.start();
    await fetchStarted;
    const closePromise = queue.close();
    await Promise.resolve();

    expect(workerUtilsMock.release).not.toHaveBeenCalled();

    resolveFetch(new Response(null, { status: 404 }));
    await closePromise;

    expect(run).not.toHaveBeenCalled();
    expect(workerUtilsMock.release).toHaveBeenCalled();
  });

  it('releases worker utils when startup migration fails', async () => {
    vi.mocked(workerUtilsMock.migrate).mockRejectedValueOnce(
      new Error('migration failed')
    );
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await expect(queue.start()).rejects.toThrow('migration failed');

    expect(workerUtilsMock.release).toHaveBeenCalledTimes(1);
  });

  it('does not restart after close', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await queue.start();
    await queue.close();

    await expect(queue.start()).rejects.toThrow('Postgres queue is closed');
    await expect(
      queue.queue('__wkf_workflow_test-workflow', { runId: 'wrun_01ABC' })
    ).rejects.toThrow('Postgres queue is closed');
    expect(() =>
      queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    ).toThrow('Postgres queue is closed');
  });

  it('uses remote HTTP execution when WORKFLOW_LOCAL_BASE_URL has no local handlers', async () => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('?__health')) {
        return new Response(null, { status: 200 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await queue.start();

    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(run).mock.calls[0]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
      workflow_steps: expect.any(Function),
    });

    const task = getTaskHandler('workflow_flows');
    const messageId = MessageId.parse('msg_01ABC');
    await task(
      buildMessageData(
        '__wkf_workflow_test-workflow',
        { runId: 'wrun_01ABC' },
        {
          messageId,
        }
      ),
      { job: { attempts: 1 } }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example.test/.well-known/workflow/v1/flow',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-vqs-queue-name': '__wkf_workflow_test-workflow',
          'x-vqs-message-id': messageId,
          'x-vqs-message-attempt': '1',
        }),
      })
    );
  });

  it.each([
    { wat: true },
    { ok: true, timeoutSeconds: 5 },
    { timeoutSeconds: -1 },
  ])('rejects invalid remote HTTP execution responses', async (body) => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('?__health')) {
        return new Response(null, { status: 200 });
      }
      return Response.json(body);
    });
    vi.stubGlobal('fetch', fetchMock);

    await queue.start();

    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    const task = getTaskHandler('workflow_flows');
    await expect(
      task(
        buildMessageData('__wkf_workflow_test-workflow', {
          runId: 'wrun_01ABC',
        }),
        { job: { attempts: 1 } }
      )
    ).rejects.toThrow();
  });

  it('uses local handlers before remote handlers for matching prefixes', async () => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const workflowRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    const mixedRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    vi.mocked(run)
      .mockResolvedValueOnce(workflowRunner)
      .mockResolvedValueOnce(mixedRunner);
    const workflowHandler = vi.fn(async () => undefined);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.createQueueHandler('__wkf_workflow_', workflowHandler);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('?__health')) {
        return new Response(null, { status: 200 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await queue.start();

    await vi.waitFor(() => {
      expect(vi.mocked(run).mock.calls.at(-1)?.[0]?.taskList).toEqual({
        workflow_flows: expect.any(Function),
        workflow_steps: expect.any(Function),
      });
    });

    const workflowTask = getLatestTaskHandler('workflow_flows');
    const stepTask = getLatestTaskHandler('workflow_steps');

    await workflowTask(
      buildMessageData('__wkf_workflow_test-workflow', {
        runId: 'wrun_01ABC',
      }),
      { job: { attempts: 1 } }
    );
    await stepTask(
      buildMessageData('__wkf_step_test-step', {
        workflowName: 'test-workflow',
        workflowRunId: 'run_01ABC',
        workflowStartedAt: Date.now(),
        stepId: 'step_01ABC',
      }),
      { job: { attempts: 1 } }
    );

    expect(workflowHandler).toHaveBeenCalledWith(
      { runId: 'wrun_01ABC' },
      expect.objectContaining({
        queueName: '__wkf_workflow_test-workflow',
      })
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url === 'https://worker.example.test/.well-known/workflow/v1/flow'
      )
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example.test/.well-known/workflow/v1/step',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-vqs-queue-name': '__wkf_step_test-step',
        }),
      })
    );
  });

  it('does not consume remote step jobs when the step route is unhealthy', async () => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/flow?__health')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/step?__health')) {
        return new Response(null, { status: 404 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await queue.start();

    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(run).mock.calls[0]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
    });
  });

  it('starts consuming remote step jobs once the step route becomes healthy', async () => {
    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'https://worker.example.test');
    const workflowRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    const combinedRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    vi.mocked(run)
      .mockResolvedValueOnce(workflowRunner)
      .mockResolvedValueOnce(combinedRunner);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    let stepRouteHealthy = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/flow?__health')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/step?__health')) {
        return new Response(null, { status: stepRouteHealthy ? 200 : 404 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await queue.start();

    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(run).mock.calls[0]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
    });

    stepRouteHealthy = true;
    await vi.waitFor(
      () => {
        expect(run).toHaveBeenCalledTimes(2);
      },
      { timeout: 1500 }
    );

    expect(workflowRunner.stop).toHaveBeenCalled();
    expect(vi.mocked(run).mock.calls[1]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
      workflow_steps: expect.any(Function),
    });
  });

  it('restarts Graphile when another queue prefix registers later', async () => {
    const workflowRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    const combinedRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    vi.mocked(run)
      .mockResolvedValueOnce(workflowRunner)
      .mockResolvedValueOnce(combinedRunner);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await queue.start();
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    queue.createQueueHandler('__wkf_step_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });

    expect(workflowRunner.stop).toHaveBeenCalled();
    expect(vi.mocked(run).mock.calls[1]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
      workflow_steps: expect.any(Function),
    });
  });

  it('restarts a running queue when another world instance registers steps', async () => {
    const workflowRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    const combinedRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    vi.mocked(run)
      .mockResolvedValueOnce(workflowRunner)
      .mockResolvedValueOnce(combinedRunner);
    const workflowQueue = buildQueue(
      { connectionString: 'postgres://test' },
      pool
    );
    const stepQueue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await workflowQueue.start();
    workflowQueue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    stepQueue.createQueueHandler('__wkf_step_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });

    expect(workflowRunner.stop).toHaveBeenCalled();
    expect(vi.mocked(run).mock.calls[1]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
      workflow_steps: expect.any(Function),
    });
  });

  it('restarts a running queue when another world instance unregisters steps', async () => {
    const workflowRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    const combinedRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    const workflowOnlyRunner = {
      stop: vi.fn(),
    } as Awaited<ReturnType<typeof run>>;
    vi.mocked(run)
      .mockResolvedValueOnce(workflowRunner)
      .mockResolvedValueOnce(combinedRunner)
      .mockResolvedValueOnce(workflowOnlyRunner);
    const workflowQueue = buildQueue(
      { connectionString: 'postgres://test' },
      pool
    );
    const stepQueue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await workflowQueue.start();
    workflowQueue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    stepQueue.createQueueHandler('__wkf_step_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });

    await stepQueue.close();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(3);
    });

    expect(combinedRunner.stop).toHaveBeenCalled();
    expect(vi.mocked(run).mock.calls[2]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
    });
  });

  it('restores a previous handler when a duplicate prefix owner closes', async () => {
    const firstHandler = vi.fn(async () => undefined);
    const secondHandler = vi.fn(async () => undefined);
    const firstQueue = buildQueue(
      { connectionString: 'postgres://test' },
      pool
    );
    const secondQueue = buildQueue(
      { connectionString: 'postgres://test' },
      pool
    );

    firstQueue.createQueueHandler('__wkf_workflow_', firstHandler);
    secondQueue.createQueueHandler('__wkf_workflow_', secondHandler);
    await firstQueue.start();

    const task = getTaskHandler('workflow_flows');
    await task(
      buildMessageData('__wkf_workflow_test-workflow', {
        runId: 'wrun_01ABC',
      }),
      { job: { attempts: 1 } }
    );

    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(firstHandler).not.toHaveBeenCalled();

    await secondQueue.close();
    await task(
      buildMessageData(
        '__wkf_workflow_test-workflow',
        {
          runId: 'wrun_01ABC',
        },
        {
          messageId: MessageId.parse('msg_01ABD'),
        }
      ),
      { job: { attempts: 1 } }
    );

    expect(firstHandler).toHaveBeenCalledTimes(1);
  });

  it('does not start direct execution when only the optional step prefix is registered', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    queue.createQueueHandler('__wkf_step_', async () => undefined);
    await queue.start();

    expect(run).not.toHaveBeenCalled();

    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(run).mock.calls[0]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
      workflow_steps: expect.any(Function),
    });
  });

  it('starts Graphile when enqueueing after handler registration', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await queue.queue('__wkf_workflow_test-workflow', { runId: 'wrun_01ABC' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]?.[0]?.taskList).toEqual({
      workflow_flows: expect.any(Function),
    });
    expect(workerUtilsMock.addJob).toHaveBeenCalled();
  });

  it('queues messages while Graphile runner replacement is draining', async () => {
    let finishStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const workflowRunner = {
      stop: vi.fn(() => stopStarted),
    } as unknown as Awaited<ReturnType<typeof run>>;
    const combinedRunner = { stop: vi.fn() } as Awaited<ReturnType<typeof run>>;
    vi.mocked(run)
      .mockResolvedValueOnce(workflowRunner)
      .mockResolvedValueOnce(combinedRunner);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await queue.start();
    queue.createQueueHandler('__wkf_step_', async () => undefined);
    await vi.waitFor(() => {
      expect(workflowRunner.stop).toHaveBeenCalled();
    });

    await queue.queue('__wkf_step_test-step', { ok: true });

    expect(workerUtilsMock.addJob).toHaveBeenCalled();
    finishStop();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  it('waits for pending Graphile startup before closing', async () => {
    let finishRun!: (runner: Awaited<ReturnType<typeof run>>) => void;
    const runStarted = new Promise<Awaited<ReturnType<typeof run>>>(
      (resolve) => {
        finishRun = resolve;
      }
    );
    vi.mocked(run).mockReturnValue(runStarted);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    await queue.start();
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    const closePromise = queue.close();
    await Promise.resolve();

    expect(workerUtilsMock.release).not.toHaveBeenCalled();

    finishRun(runnerMock);
    await closePromise;

    expect(runnerMock.stop).toHaveBeenCalled();
    expect(workerUtilsMock.release).toHaveBeenCalled();
  });

  it('executes Graphile workflow jobs through the registered handler without fetch', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be used');
    });
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);

    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();

    const task = getTaskHandler('workflow_flows');
    const message = { runId: 'wrun_01ABC' };
    const messageId = MessageId.parse('msg_01ABC');

    await task(
      buildMessageData('__wkf_workflow_test-workflow', message, {
        headers: { traceparent: 'trace-parent' },
        messageId,
      }),
      { job: { attempts: 2 } }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(message, {
      attempt: 2,
      queueName: '__wkf_workflow_test-workflow',
      messageId,
      requestId: undefined,
    });
  });

  it('keeps the returned HTTP queue handler contract for route requests', async () => {
    const handler = vi.fn(async () => ({ timeoutSeconds: 5 }));
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    const route = queue.createQueueHandler('__wkf_workflow_', handler);
    const message = { runId: 'wrun_01ABC' };
    const messageId = MessageId.parse('msg_01ABC');

    const response = await route(
      new Request('http://localhost/.well-known/workflow/v1/flow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vqs-queue-name': '__wkf_workflow_test-workflow',
          'x-vqs-message-id': messageId,
          'x-vqs-message-attempt': '3',
          'x-vercel-id': 'iad1::request-id',
        },
        body: transport.serialize(message),
      })
    );

    await expect(response.json()).resolves.toEqual({ timeoutSeconds: 5 });
    expect(handler).toHaveBeenCalledWith(message, {
      attempt: 3,
      queueName: '__wkf_workflow_test-workflow',
      messageId,
      requestId: 'iad1::request-id',
    });
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
    const handler = vi.fn(async () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      if (requestCount === 1) {
        resolveFirstRequestStarted();
        await releaseFirstRequest;
      }

      activeRequests -= 1;
    });

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();

    const task = getTaskHandler('workflow_flows');
    const payload = { runId: 'wrun_01ABC' };
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
    expect(handler).toHaveBeenCalledTimes(2);
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
    const handler = vi.fn(async () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      if (requestCount === 1) {
        resolveFirstRequestStarted();
        await releaseFirstRequest;
      }

      activeRequests -= 1;
    });

    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace: 'custom' },
      pool
    );
    queue.createQueueHandler('__custom_wkf_workflow_', handler);
    await queue.start();

    const task = getTaskHandler('workflow_flows');
    const payload = { runId: 'wrun_01ABC' };
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
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not require a runId for workflow health-check payloads', async () => {
    const handler = vi.fn(async () => undefined);
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();

    const task = getTaskHandler('workflow_flows');
    const payload = buildMessageData('__wkf_workflow_health_check', {
      __healthCheck: true,
      correlationId: 'hc_01ABC',
    });

    await expect(task(payload, {} as any)).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledWith(
      { __healthCheck: true, correlationId: 'hc_01ABC' },
      expect.objectContaining({
        queueName: '__wkf_workflow_health_check',
      })
    );
  });

  it('durably requeues handler timeout results in graphile', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    queue.createQueueHandler('__wkf_step_', async () => ({
      timeoutSeconds: 5,
    }));
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

    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_steps',
      expect.objectContaining({
        attempt: 2,
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
  });

  it('rejects negative handler timeout results', async () => {
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    queue.createQueueHandler('__wkf_step_', async () => ({
      timeoutSeconds: -1,
    }));
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const message = {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    } satisfies QueuePayload;

    await expect(
      task(buildMessageData('__wkf_step_test-step', message), {} as any)
    ).rejects.toThrow();

    expect(workerUtilsMock.addJob).not.toHaveBeenCalled();
  });

  it('coalesces concurrent deliveries with the same idempotency key', async () => {
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerReleased;
    });
    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    queue.createQueueHandler('__wkf_step_', handler);
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const message = {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    } satisfies QueuePayload;

    const first = task(
      buildMessageData('__wkf_step_test-step', message, {
        idempotencyKey: 'step_01ABC',
        messageId: MessageId.parse('msg_01ABC'),
      }),
      {} as any
    );
    const second = task(
      buildMessageData('__wkf_step_test-step', message, {
        idempotencyKey: 'step_01ABC',
        messageId: MessageId.parse('msg_01ABD'),
      }),
      {} as any
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);

    releaseHandler();
    await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('queues producer delays and headers in graphile job metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const queue = buildQueue({ connectionString: 'postgres://test' }, pool);
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
  });

  it('queues namespaced producer messages in graphile job metadata', async () => {
    const queue = buildQueue(
      { connectionString: 'postgres://test', namespace: 'custom' },
      pool
    );
    await queue.start();

    await queue.queue(
      '__custom_wkf_step_test-step',
      {
        workflowName: 'test-workflow',
        workflowRunId: 'run_01ABC',
        workflowStartedAt: Date.now(),
        stepId: 'step_01ABC',
      },
      {
        idempotencyKey: 'step_01ABC',
      }
    );

    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_steps',
      expect.objectContaining({
        attempt: 1,
        id: 'test-step',
        idempotencyKey: 'step_01ABC',
      }),
      expect.objectContaining({
        jobKey: 'step_01ABC',
        maxAttempts: 3,
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

function getTaskHandler(name: 'workflow_flows' | 'workflow_steps') {
  const taskList = vi.mocked(run).mock.calls[0]?.[0]?.taskList;
  const task = taskList?.[name];
  expect(task).toBeTypeOf('function');
  return task as (payload: unknown, helpers: unknown) => Promise<void>;
}

function getLatestTaskHandler(name: 'workflow_flows' | 'workflow_steps') {
  const taskList = vi.mocked(run).mock.calls.at(-1)?.[0]?.taskList;
  const task = taskList?.[name];
  expect(task).toBeTypeOf('function');
  return task as (payload: unknown, helpers: unknown) => Promise<void>;
}
