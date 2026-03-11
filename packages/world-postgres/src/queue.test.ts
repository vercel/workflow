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

    const taskList = vi.mocked(run).mock.calls[0]?.[0]?.taskList;
    expect(taskList).toBeDefined();

    const message = {
      runId: 'run_01ABC',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_workflow_test-flow', message);

    await taskList.workflow_flows(payload);

    expect(executeMessage).toHaveBeenCalledWith({
      queueName: '__wkf_workflow_test-flow',
      messageId: payload.messageId,
      attempt: 1,
      body: transport.serialize(message),
    });
  });

  it('retries direct execution in-process while preserving attempt metadata', async () => {
    executeMessage
      .mockResolvedValueOnce({ type: 'reschedule', timeoutSeconds: 0 })
      .mockResolvedValueOnce({ type: 'completed' });

    const queue = createQueue(
      { connectionString: 'postgres://test' },
      postgres
    );
    await queue.start();

    const taskList = vi.mocked(run).mock.calls[0]?.[0]?.taskList;
    const message = {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    } satisfies QueuePayload;
    const payload = buildMessageData('__wkf_step_test-step', message);

    await taskList.workflow_steps(payload);

    expect(executeMessage).toHaveBeenNthCalledWith(1, {
      queueName: '__wkf_step_test-step',
      messageId: payload.messageId,
      attempt: 1,
      body: transport.serialize(message),
    });
    expect(executeMessage).toHaveBeenNthCalledWith(2, {
      queueName: '__wkf_step_test-step',
      messageId: payload.messageId,
      attempt: 2,
      body: transport.serialize(message),
    });
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

    const taskList = vi.mocked(run).mock.calls[0]?.[0]?.taskList;
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

    const first = taskList.workflow_steps(payload);
    const second = taskList.workflow_steps(payload);

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

    const taskList = vi.mocked(run).mock.calls[0]?.[0]?.taskList;
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

    await taskList.workflow_steps(payload);
    await taskList.workflow_steps(payload);

    expect(executeMessage).toHaveBeenCalledTimes(1);
  });
});

function buildMessageData(queueName: string, payload: QueuePayload) {
  const [, id] = queueName.startsWith('__wkf_step_')
    ? ['__wkf_step_', queueName.slice('__wkf_step_'.length)]
    : ['__wkf_workflow_', queueName.slice('__wkf_workflow_'.length)];

  return MessageData.encode({
    id,
    data: transport.serialize(payload),
    attempt: 1,
    messageId: MessageId.parse('msg_01ABC'),
  });
}
