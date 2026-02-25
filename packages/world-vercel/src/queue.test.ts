import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSend,
  MockDuplicateMessageError,
  MockQueueClient,
  mockHandleCallback,
} = vi.hoisted(() => {
  class MockDuplicateMessageError extends Error {
    public readonly idempotencyKey?: string;
    constructor(message: string, idempotencyKey?: string) {
      super(message);
      this.name = 'DuplicateMessageError';
      this.idempotencyKey = idempotencyKey;
    }
  }

  const mockSend = vi.fn();
  const mockHandleCallback = vi.fn();
  const MockQueueClient = vi.fn().mockImplementation(() => ({
    send: mockSend,
    handleCallback: mockHandleCallback,
  }));

  return {
    mockSend,
    MockDuplicateMessageError,
    MockQueueClient,
    mockHandleCallback,
  };
});

vi.mock('@vercel/queue', () => ({
  QueueClient: MockQueueClient,
  DuplicateMessageError: MockDuplicateMessageError,
}));

vi.mock('./utils.js', () => ({
  getHttpUrl: vi
    .fn()
    .mockReturnValue({ baseUrl: 'http://localhost:3000', usingProxy: false }),
  getHeaders: vi.fn().mockReturnValue(new Map()),
}));

import { createQueue } from './queue.js';

describe('createQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('queue()', () => {
    it('should send message with payload and queueName', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await queue.queue('__wkf_workflow_test', { runId: 'run-123' });

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const payload = mockSend.mock.calls[0][1];

        expect(payload.payload).toEqual({ runId: 'run-123' });
        expect(payload.queueName).toBe('__wkf_workflow_test');
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should throw when no deploymentId and VERCEL_DEPLOYMENT_ID is not set', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      delete process.env.VERCEL_DEPLOYMENT_ID;

      try {
        const queue = createQueue();
        await expect(
          queue.queue('__wkf_workflow_test', { runId: 'run-123' })
        ).rejects.toThrow(
          'No deploymentId provided and VERCEL_DEPLOYMENT_ID environment variable is not set'
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        }
      }
    });

    it('should not throw when deploymentId is provided in options', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      delete process.env.VERCEL_DEPLOYMENT_ID;

      try {
        const queue = createQueue();
        await expect(
          queue.queue(
            '__wkf_workflow_test',
            { runId: 'run-123' },
            { deploymentId: 'dpl_123' }
          )
        ).resolves.toEqual({ messageId: 'msg-123' });

        expect(MockQueueClient).toHaveBeenCalledWith(
          expect.objectContaining({ deploymentId: 'dpl_123' })
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        }
      }
    });

    it('should not throw when VERCEL_DEPLOYMENT_ID is set', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_env_123';

      try {
        const queue = createQueue();
        await expect(
          queue.queue('__wkf_workflow_test', { runId: 'run-123' })
        ).resolves.toEqual({ messageId: 'msg-123' });

        expect(MockQueueClient).toHaveBeenCalledWith(
          expect.objectContaining({ deploymentId: 'dpl_env_123' })
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should silently handle idempotency key conflicts', async () => {
      mockSend.mockRejectedValue(
        new MockDuplicateMessageError(
          'Duplicate idempotency key detected',
          'my-key'
        )
      );

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        const result = await queue.queue(
          '__wkf_workflow_test',
          { runId: 'run-123' },
          { idempotencyKey: 'my-key' }
        );

        expect(result.messageId).toBe('msg_duplicate_my-key');
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should auto-inject x-workflow-run-id header for workflow payloads', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc123' });

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts).toEqual(
          expect.objectContaining({
            headers: expect.objectContaining({
              'x-workflow-run-id': 'wrun_abc123',
            }),
          })
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should auto-inject x-workflow-run-id and x-workflow-step-id headers for step payloads', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await queue.queue('__wkf_step_myStep', {
          workflowName: 'test-workflow',
          workflowRunId: 'wrun_abc123',
          workflowStartedAt: Date.now(),
          stepId: 'step_xyz789',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts).toEqual(
          expect.objectContaining({
            headers: expect.objectContaining({
              'x-workflow-run-id': 'wrun_abc123',
              'x-workflow-step-id': 'step_xyz789',
            }),
          })
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should not inject workflow headers for health check payloads', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await queue.queue('__wkf_workflow_health_check', {
          __healthCheck: true as const,
          correlationId: 'corr_123',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts.headers).toEqual({});
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should allow caller headers to override auto-injected headers', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await queue.queue(
          '__wkf_workflow_test',
          { runId: 'wrun_abc123' },
          {
            headers: {
              'x-workflow-run-id': 'wrun_override',
              'x-custom-header': 'custom-value',
            },
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts.headers).toEqual({
          'x-workflow-run-id': 'wrun_override',
          'x-custom-header': 'custom-value',
        });
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should rethrow non-idempotency errors', async () => {
      mockSend.mockRejectedValue(new Error('Some other error'));

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await expect(
          queue.queue('__wkf_workflow_test', { runId: 'run-123' })
        ).rejects.toThrow('Some other error');
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });
  });

  describe('createQueueHandler()', () => {
    const setupHandler = ({ timeoutSeconds }: { timeoutSeconds: number }) => {
      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });

      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async () => ({
        timeoutSeconds,
      }));

      return capturedHandler!;
    };

    it('should call handleCallback without topic pattern', () => {
      mockHandleCallback.mockReturnValue(async () => new Response('ok'));

      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async () => undefined);

      expect(mockHandleCallback).toHaveBeenCalledTimes(1);
      expect(mockHandleCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should send new message with delaySeconds when handler returns timeoutSeconds', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });

      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        queue.createQueueHandler('__wkf_workflow_', async () => ({
          timeoutSeconds: 300,
        }));

        await capturedHandler!(
          {
            payload: { runId: 'run-123' },
            queueName: '__wkf_workflow_test',
            deploymentId: 'dpl_original',
          },
          {
            messageId: 'msg-123',
            deliveryCount: 1,
            createdAt: new Date(),
            topicName: '__wkf_workflow_test',
            consumerGroup: 'test',
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts.delaySeconds).toBe(300);
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should clamp delaySeconds to max 23 hours for long sleeps', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });

      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        queue.createQueueHandler('__wkf_workflow_', async () => ({
          timeoutSeconds: 100000,
        }));

        await capturedHandler!(
          {
            payload: { runId: 'run-123' },
            queueName: '__wkf_workflow_test',
            deploymentId: 'dpl_original',
          },
          {
            messageId: 'msg-123',
            deliveryCount: 1,
            createdAt: new Date(),
            topicName: '__wkf_workflow_test',
            consumerGroup: 'test',
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts.delaySeconds).toBe(82800); // MAX_DELAY_SECONDS
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });

    it('should not send new message when handler returns void', async () => {
      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });

      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async () => undefined);

      await capturedHandler!(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        {
          messageId: 'msg-123',
          deliveryCount: 1,
          createdAt: new Date(),
          topicName: '__wkf_workflow_test',
          consumerGroup: 'test',
        }
      );

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should handle null message gracefully', async () => {
      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });

      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async () => undefined);

      await capturedHandler!(null, null);

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should auto-inject x-workflow-run-id header on delayed re-enqueue', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 300 });

      await handler(
        {
          payload: { runId: 'wrun_abc123' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      // send(topicName, payload, options)
      const sendOpts = mockSend.mock.calls[0][2];
      expect(sendOpts).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-workflow-run-id': 'wrun_abc123',
          }),
        })
      );
    });

    it('should auto-inject step headers on delayed re-enqueue for step payloads', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 300 });

      const stepPayload = {
        workflowName: 'test-workflow',
        workflowRunId: 'wrun_abc123',
        workflowStartedAt: Date.now(),
        stepId: 'step_xyz789',
      };

      await handler(
        {
          payload: stepPayload,
          queueName: '__wkf_step_myStep',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      // send(topicName, payload, options)
      const sendOpts = mockSend.mock.calls[0][2];
      expect(sendOpts).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-workflow-run-id': 'wrun_abc123',
            'x-workflow-step-id': 'step_xyz789',
          }),
        })
      );
    });

    it('should handle step payloads correctly', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });

      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const stepPayload = {
          workflowName: 'test-workflow',
          workflowRunId: 'run-123',
          workflowStartedAt: Date.now(),
          stepId: 'step-456',
        };

        const queue = createQueue();
        queue.createQueueHandler('__wkf_step_', async () => ({
          timeoutSeconds: 3600,
        }));

        await capturedHandler!(
          {
            payload: stepPayload,
            queueName: '__wkf_step_myStep',
            deploymentId: 'dpl_original',
          },
          {
            messageId: 'msg-123',
            deliveryCount: 1,
            createdAt: new Date(),
            topicName: '__wkf_step_myStep',
            consumerGroup: 'test',
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const payload = mockSend.mock.calls[0][1];
        expect(payload.payload).toEqual(stepPayload);
        expect(payload.queueName).toBe('__wkf_step_myStep');
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });
  });
});
