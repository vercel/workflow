import { JsonTransport } from '@vercel/queue';
import { MessageId, type QueuePayload } from '@workflow/world';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorld, createQueueExecutor } from '@workflow/world-local';
import { createQueue } from './queue.js';

const transport = new JsonTransport();

vi.mock('@aws-sdk/client-sqs', () => {
  const SQSClient = vi.fn();
  SQSClient.prototype.send = vi.fn();
  return {
    SQSClient,
    SendMessageCommand: vi.fn(),
    ReceiveMessageCommand: vi.fn(),
    DeleteMessageCommand: vi.fn(),
  };
});

vi.mock('@workflow/world-local', () => ({
  createLocalWorld: vi.fn(),
  createQueueExecutor: vi.fn(),
}));

describe('aws queue', () => {
  const sqsSendMock = vi.fn();
  const executeMessage = vi.fn();
  const registerHandler = vi.fn();
  const executorClose = vi.fn();
  const wrappedHandler = vi.fn(async () => Response.json({ ok: true }));
  const localWorldClose = vi.fn();
  const createQueueHandler = vi.fn(() => wrappedHandler);

  beforeEach(() => {
    vi.clearAllMocks();

    const mockSqs = { send: sqsSendMock, destroy: vi.fn() } as any;
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

  function createTestQueue() {
    const mockSqs = { send: sqsSendMock, destroy: vi.fn() } as any;
    return createQueue(
      {
        region: 'us-east-1',
        tablePrefix: 'workflow',
        queueConcurrency: 10,
        pollIntervalMs: 1000,
        sqsWorkflowQueueUrl:
          'https://sqs.us-east-1.amazonaws.com/123/workflow-wf',
        sqsStepQueueUrl:
          'https://sqs.us-east-1.amazonaws.com/123/workflow-step',
      },
      mockSqs
    );
  }

  it('registers queue handlers with the shared executor', () => {
    const queue = createTestQueue();
    const handler = vi.fn(async () => undefined);

    const wrapped = queue.createQueueHandler('__wkf_step_', handler);

    expect(createQueueHandler).toHaveBeenCalledWith('__wkf_step_', handler);
    expect(registerHandler).toHaveBeenCalledWith('__wkf_step_', wrappedHandler);
    expect(wrapped).toBe(wrappedHandler);
  });

  it('returns deployment id as "aws"', async () => {
    const queue = createTestQueue();
    const deploymentId = await queue.getDeploymentId();
    expect(deploymentId).toBe('aws');
  });

  it('sends messages to SQS with delay', async () => {
    sqsSendMock.mockResolvedValue({});

    const queue = createTestQueue();
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

    expect(sqsSendMock).toHaveBeenCalled();
    // Verify SendMessageCommand was called with the right queue URL
    const sendCall = vi.mocked(SendMessageCommand).mock.calls[0];
    expect(sendCall[0]).toMatchObject({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/workflow-step',
      DelaySeconds: 5,
    });
    // Verify message body contains the right data
    const body = JSON.parse(sendCall[0].MessageBody!);
    expect(body.id).toBe('test-step');
    expect(body.attempt).toBe(1);
    expect(body.idempotencyKey).toBe('step_01ABC');
    expect(body.headers).toEqual({ traceparent: 'trace-parent' });
  });

  it('caps delay to 900 seconds (SQS max)', async () => {
    sqsSendMock.mockResolvedValue({});

    const queue = createTestQueue();
    await queue.start();

    await queue.queue(
      '__wkf_workflow_test-wf',
      {
        runId: 'run_01ABC',
      },
      {
        delaySeconds: 2000,
      }
    );

    const sendCall = vi.mocked(SendMessageCommand).mock.calls[0];
    expect(sendCall[0].DelaySeconds).toBe(900);
  });

  it('closes cleanly', async () => {
    const queue = createTestQueue();
    await queue.start();
    await queue.close();

    expect(executorClose).toHaveBeenCalled();
    expect(localWorldClose).toHaveBeenCalled();
  });
});
