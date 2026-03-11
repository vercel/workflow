import { JsonTransport } from '@vercel/queue';
import { MessageId, type QueuePayload } from '@workflow/world';
import { makeWorkerUtils, run, type WorkerUtils } from 'graphile-worker';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorld, createQueueExecutor } from '@workflow/world-local';
import { createQueue } from './queue.js';
import { MessageData } from './message.js';

const transport = new JsonTransport();

vi.mock('graphile-worker', () => ({
  Logger: class Logger {
    constructor(_: unknown) {}
  },
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@workflow/world-local', () => ({
  createLocalWorld: vi.fn(),
  createQueueExecutor: vi.fn(),
}));

describe('postgres queue direct execution', () => {
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
    vi.mocked(run).mockResolvedValue(runnerMock as any);
    vi.mocked(createQueueExecutor).mockReturnValue({
      executeMessage,
      registerHandler,
      close: executorClose,
    });
    vi.mocked(createLocalWorld).mockReturnValue({
      createQueueHandler,
      close: localWorldClose,
    } as any);
  });

  it('registers queue handlers with the shared executor', () => {
    const queue = createQueue(
      { connectionString: 'postgres://test' },
      postgres
    );
    const handler = vi.fn(async () => undefined);

    const wrapped = queue.createQueueHandler('__wkf_step_', handler);

    expect(createQueueHandler).toHaveBeenCalledWith('__wkf_step_', handler);
    expect(registerHandler).toHaveBeenCalledWith('__wkf_step_', wrappedHandler);
    expect(wrapped).toBe(wrappedHandler);
  });

  it('executes graphile jobs through the extracted executor', async () => {
    executeMessage.mockResolvedValueOnce({ type: 'completed' });
    const queue = createQueue(
      { connectionString: 'postgres://test' },
      postgres
    );

    await queue.start();

    const task = getTaskHandler('workflow_flows');

    const message = {
      runId: 'run_01ABC',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_workflow_test-flow', message, {
      headers: { traceparent: 'trace-parent' },
    });

    await task(payload, {} as any);

    expect(executeMessage).toHaveBeenCalledWith({
      queueName: '__wkf_workflow_test-flow',
      messageId: payload.messageId,
      attempt: 1,
      body: transport.serialize(message),
      headers: { traceparent: 'trace-parent' },
    });
  });

  it('durably reschedules execution with incremented attempt metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    try {
      executeMessage.mockResolvedValueOnce({
        type: 'reschedule',
        timeoutSeconds: 5,
      });

      const queue = createQueue(
        { connectionString: 'postgres://test' },
        postgres
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
        idempotencyKey: 'step_01ABC',
        headers: { traceparent: 'trace-parent' },
      });

      await task(payload, {} as any);

      expect(executeMessage).toHaveBeenCalledWith({
        queueName: '__wkf_step_test-step',
        messageId: payload.messageId,
        attempt: 1,
        body: transport.serialize(message),
        headers: { traceparent: 'trace-parent' },
      });

      expect(workerUtilsMock.addJob).toHaveBeenLastCalledWith(
        'workflow_steps',
        {
          attempt: 2,
          data: payload.data,
          headers: { traceparent: 'trace-parent' },
          id: 'test-step',
          idempotencyKey: 'step_01ABC',
          messageId: payload.messageId,
        },
        {
          jobKey: 'step_01ABC',
          maxAttempts: 3,
          runAt: new Date('2024-01-01T00:00:05.000Z'),
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent executions with the same idempotency key', async () => {
    let releaseExecution!: () => void;
    executeMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseExecution = () => resolve({ type: 'completed' });
        })
    );

    const queue = createQueue(
      { connectionString: 'postgres://test' },
      postgres
    );
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const payload = MessageData.encode({
      id: 'test-step',
      data: transport.serialize({
        workflowName: 'test-workflow',
        workflowRunId: 'run_01ABC',
        workflowStartedAt: Date.now(),
        stepId: 'step_01ABC',
      }),
      attempt: 1,
      messageId: MessageId.parse('msg_01ABC'),
      idempotencyKey: 'step_01ABC',
    });

    const first = task(payload, {} as any);
    const second = task(payload, {} as any);

    await vi.waitFor(() => {
      expect(executeMessage).toHaveBeenCalledTimes(1);
    });

    releaseExecution();
    await Promise.all([first, second]);
  });

  it('skips duplicate executions after the first idempotent run completes', async () => {
    executeMessage.mockResolvedValueOnce({ type: 'completed' });

    const queue = createQueue(
      { connectionString: 'postgres://test' },
      postgres
    );
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const payload = MessageData.encode({
      id: 'test-step',
      data: transport.serialize({
        workflowName: 'test-workflow',
        workflowRunId: 'run_01ABC',
        workflowStartedAt: Date.now(),
        stepId: 'step_01ABC',
      }),
      attempt: 1,
      messageId: MessageId.parse('msg_01ABC'),
      idempotencyKey: 'step_01ABC',
    });

    await task(payload, {} as any);
    await task(payload, {} as any);

    expect(executeMessage).toHaveBeenCalledTimes(1);
  });

  it('forwards graphile retry attempts to queue execution metadata', async () => {
    executeMessage.mockResolvedValueOnce({ type: 'completed' });

    const queue = createQueue(
      { connectionString: 'postgres://test' },
      postgres
    );
    await queue.start();

    const task = getTaskHandler('workflow_steps');
    const payload = MessageData.encode({
      id: 'test-step',
      data: transport.serialize({
        workflowName: 'test-workflow',
        workflowRunId: 'run_01ABC',
        workflowStartedAt: Date.now(),
        stepId: 'step_01ABC',
      }),
      attempt: 1,
      messageId: MessageId.parse('msg_01ABC'),
    });

    await task(payload, { job: { attempts: 4 } });

    expect(executeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 4,
      })
    );
  });

  it('queues producer delays and headers in graphile job metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    try {
      const queue = createQueue(
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
