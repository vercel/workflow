import type { QueuePayload } from '@workflow/world';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorld, createQueueExecutor } from '@workflow/world-local';
import { createQueue } from './queue.js';

vi.mock('@workflow/world-local', () => ({
  createLocalWorld: vi.fn(),
  createQueueExecutor: vi.fn(),
}));

describe('cloudflare queue', () => {
  const executeMessage = vi.fn();
  const registerHandler = vi.fn();
  const executorClose = vi.fn();
  const wrappedHandler = vi.fn(async () => Response.json({ ok: true }));
  const localWorldClose = vi.fn();
  const createQueueHandler = vi.fn(() => wrappedHandler);
  const queueSend = vi.fn();

  const mockConfig = {
    db: {} as any,
    runs: {} as any,
    queue: { send: queueSend } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();

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
    const queue = createQueue(mockConfig);
    const handler = vi.fn(async () => undefined);

    const wrapped = queue.createQueueHandler('__wkf_step_', handler);

    expect(createQueueHandler).toHaveBeenCalledWith('__wkf_step_', handler);
    expect(registerHandler).toHaveBeenCalledWith('__wkf_step_', wrappedHandler);
    expect(wrapped).toBe(wrappedHandler);
  });

  it('sends messages to the cloudflare queue', async () => {
    const queue = createQueue(mockConfig);

    const message = {
      runId: 'run_01ABC',
    } satisfies QueuePayload;

    const result = await queue.queue('__wkf_workflow_test-flow', message, {
      headers: { traceparent: 'trace-parent' },
      idempotencyKey: 'idem-key',
      delaySeconds: 5,
    });

    expect(result.messageId).toBeTruthy();
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: '__wkf_workflow_test-flow',
        payload: message,
        attempt: 1,
        idempotencyKey: 'idem-key',
        headers: { traceparent: 'trace-parent' },
      }),
      expect.objectContaining({
        delaySeconds: 5,
      })
    );
  });

  it('sends messages without delay when delaySeconds not specified', async () => {
    const queue = createQueue(mockConfig);

    await queue.queue('__wkf_step_test-step', {
      workflowName: 'test-workflow',
      workflowRunId: 'run_01ABC',
      workflowStartedAt: Date.now(),
      stepId: 'step_01ABC',
    });

    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: '__wkf_step_test-step',
        attempt: 1,
      }),
      expect.not.objectContaining({
        delaySeconds: expect.anything(),
      })
    );
  });

  it('returns cloudflare as deployment id', async () => {
    const queue = createQueue(mockConfig);
    const deploymentId = await queue.getDeploymentId();
    expect(deploymentId).toBe('cloudflare');
  });

  it('processes queue batch messages and acks on completion', async () => {
    executeMessage.mockResolvedValueOnce({ type: 'completed' });

    const queue = createQueue(mockConfig);

    const ack = vi.fn();
    const retry = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            queueName: '__wkf_workflow_test-flow' as const,
            payload: { runId: 'run_01ABC' },
            messageId: 'msg_01ABC',
            attempt: 1,
          },
          ack,
          retry,
        },
      ],
    } as any;

    await queue.handleQueueBatch(mockBatch);

    expect(executeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: '__wkf_workflow_test-flow',
        messageId: expect.any(String),
        attempt: 1,
      })
    );
    expect(ack).toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('reschedules messages on reschedule result', async () => {
    executeMessage.mockResolvedValueOnce({
      type: 'reschedule',
      timeoutSeconds: 5,
    });

    const queue = createQueue(mockConfig);

    const ack = vi.fn();
    const retry = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            queueName: '__wkf_step_test-step' as const,
            payload: {
              workflowName: 'test-workflow',
              workflowRunId: 'run_01ABC',
              workflowStartedAt: Date.now(),
              stepId: 'step_01ABC',
            },
            messageId: 'msg_01ABC',
            attempt: 1,
          },
          ack,
          retry,
        },
      ],
    } as any;

    await queue.handleQueueBatch(mockBatch);

    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 2,
      }),
      expect.objectContaining({
        delaySeconds: 5,
      })
    );
    expect(ack).toHaveBeenCalled();
  });

  it('retries messages on failure', async () => {
    executeMessage.mockRejectedValueOnce(new Error('boom'));

    const queue = createQueue(mockConfig);

    const ack = vi.fn();
    const retry = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            queueName: '__wkf_workflow_test-flow' as const,
            payload: { runId: 'run_01ABC' },
            messageId: 'msg_01ABC',
            attempt: 1,
          },
          ack,
          retry,
        },
      ],
    } as any;

    await queue.handleQueueBatch(mockBatch);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalled();
  });
});
