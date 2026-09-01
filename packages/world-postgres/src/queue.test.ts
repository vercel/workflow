import { MessageId, parseQueueName, type QueuePayload } from '@workflow/world';
import {
  type JobHelpers,
  makeWorkerUtils,
  type Runner,
  run,
  type Task,
  type WorkerUtils,
} from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageData } from './message.js';
import { createQueue, encodeQueueMessage } from './queue.js';

const queues: Array<ReturnType<typeof createQueue>> = [];

vi.mock('graphile-worker', () => ({
  Logger: class Logger {
    constructor(_: unknown) {}
  },
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

describe('postgres queue', () => {
  const workerUtils = {
    addJob: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const runner = {
    stop: vi.fn(),
    promise: Promise.resolve(),
  } as unknown as Runner;
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtils);
    vi.mocked(run).mockResolvedValue(runner);
  });

  afterEach(async () => {
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
  });

  it('requires handler registration before starting', async () => {
    const queue = buildQueue(pool);

    await expect(queue.start()).rejects.toThrow(
      'Import the generated flow route'
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('registers one direct handler and leaves the HTTP route inert', async () => {
    const queue = buildQueue(pool);
    const handler = vi.fn(async () => undefined);

    const httpHandler = queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();

    await expect(
      httpHandler(new Request('https://example.test/?__health'))
    ).resolves.toMatchObject({ status: 404 });
    expect(run).toHaveBeenCalledOnce();
  });

  it('passes messages and logical attempts directly to the handler', async () => {
    const queue = buildQueue(pool);
    const handler = vi.fn(async () => undefined);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();
    const message = stepMessage();

    await task()(
      messageData('__wkf_workflow_test-step', message, { attempt: 4 }),
      jobHelpers(3)
    );

    expect(handler).toHaveBeenCalledWith(message, {
      attempt: 6,
      messageId: 'msg_01ABC',
      queueName: '__wkf_workflow_test-step',
    });
  });

  it('writes a timeout successor before completing the delivery', async () => {
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_workflow_', async () => ({
      timeoutSeconds: 5,
    }));
    await queue.start();

    await task()(
      messageData('__wkf_workflow_test-step', stepMessage(), {
        attempt: 2,
        idempotencyKey: 'step_01ABC',
      }),
      jobHelpers(2)
    );

    expect(workerUtils.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({ attempt: 4 }),
      expect.objectContaining({ jobKey: 'step_01ABC' })
    );
  });

  it('propagates handler failures for Graphile to retry', async () => {
    const queue = buildQueue(pool);
    const failure = new Error('handler failed');
    queue.createQueueHandler('__wkf_workflow_', async () => {
      throw failure;
    });
    await queue.start();

    await expect(
      task()(
        messageData('__wkf_workflow_test-step', stepMessage()),
        jobHelpers()
      )
    ).rejects.toBe(failure);
    expect(workerUtils.addJob).not.toHaveBeenCalled();
  });

  it('does not start a worker in enqueue-only processes', async () => {
    const queue = buildQueue(pool);

    await queue.queue('__wkf_workflow_test-step', stepMessage());

    expect(workerUtils.addJob).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves same-run replay serialization', async () => {
    const queue = buildQueue(pool);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => blocked)
      .mockResolvedValue(undefined);
    queue.createQueueHandler('__wkf_workflow_', handler);
    await queue.start();
    const payload = messageData('__wkf_workflow_test-workflow', {
      runId: 'wrun_01ABC',
    });

    const first = task()(payload, jobHelpers());
    const second = task()(payload, jobHelpers());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects a handler for another namespace', () => {
    const queue = buildQueue(pool, { namespace: 'custom' });

    expect(() =>
      queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    ).toThrow();
  });

  it('passes application-managed shutdown to Graphile', async () => {
    const queue = buildQueue(pool, { applicationManagedShutdown: true });
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);

    await queue.start();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ noHandleSignals: true })
    );
  });

  it('closes once when called concurrently', async () => {
    const queue = buildQueue(pool);
    queue.createQueueHandler('__wkf_workflow_', async () => undefined);
    await queue.start();

    await Promise.all([queue.close(), queue.close()]);

    expect(runner.stop).toHaveBeenCalledOnce();
    expect(workerUtils.release).toHaveBeenCalledOnce();
  });
});

function buildQueue(
  pool: Parameters<typeof createQueue>[1],
  config: Partial<Parameters<typeof createQueue>[0]> = {}
) {
  const queue = createQueue(
    { connectionString: 'postgres://test', ...config },
    pool
  );
  queues.push(queue);
  return queue;
}

function stepMessage(): QueuePayload {
  return {
    runId: 'run_01ABC',
    stepId: 'step_01ABC',
    stepName: 'test-step',
  };
}

function messageData(
  queueName: string,
  payload: QueuePayload,
  options: {
    attempt?: number;
    idempotencyKey?: string;
  } = {}
) {
  const { id } = parseQueueName(queueName);
  return MessageData.encode({
    id,
    data: encodeQueueMessage(payload),
    attempt: options.attempt ?? 1,
    idempotencyKey: options.idempotencyKey,
    messageId: MessageId.parse('msg_01ABC'),
  });
}

function jobHelpers(attempts = 1): JobHelpers {
  return {
    abortSignal: new AbortController().signal,
    job: { attempts },
  } as JobHelpers;
}

function task(): Task {
  const handler = vi.mocked(run).mock.calls[0]?.[0]?.taskList?.workflow_flows;
  expect(handler).toBeTypeOf('function');
  return handler as Task;
}
