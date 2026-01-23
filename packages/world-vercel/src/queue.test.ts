import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted to define mocks that will be available to vi.mock
const { mockSend, mockHandleCallback, MockDuplicateMessageError } = vi.hoisted(
  () => {
    // DuplicateMessageError mock class
    class MockDuplicateMessageError extends Error {
      public readonly idempotencyKey?: string;
      constructor(message: string, idempotencyKey?: string) {
        super(message);
        this.name = 'DuplicateMessageError';
        this.idempotencyKey = idempotencyKey;
      }
    }

    return {
      mockSend: vi.fn(),
      mockHandleCallback: vi.fn(),
      MockDuplicateMessageError,
    };
  }
);

vi.mock('@vercel/queue', () => ({
  Client: vi.fn().mockImplementation(() => ({
    send: mockSend,
    handleCallback: mockHandleCallback,
  })),
  DuplicateMessageError: MockDuplicateMessageError,
}));

// Mock utils
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
        const sentPayload = mockSend.mock.calls[0][1];

        expect(sentPayload.payload).toEqual({ runId: 'run-123' });
        expect(sentPayload.queueName).toBe('__wkf_workflow_test');
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

      // Ensure VERCEL_DEPLOYMENT_ID is not set
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

      // Ensure VERCEL_DEPLOYMENT_ID is not set
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

        // Should not throw, and should return a placeholder messageId
        // Uses error.idempotencyKey when available
        expect(result.messageId).toBe('msg_duplicate_my-key');
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
    // Helper to simulate handleCallback behavior and capture the internal handler
    function setupHandler(handlerResult: { timeoutSeconds: number } | void) {
      const capturedHandlers: Record<
        string,
        { default: (body: unknown, meta: unknown) => Promise<unknown> }
      > = {};

      mockHandleCallback.mockImplementation((handlers) => {
        Object.assign(capturedHandlers, handlers);
        return async (req: Request) => new Response('ok');
      });

      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async () => handlerResult);

      // Get the handler that was registered
      const handlerKey = Object.keys(capturedHandlers)[0];
      return capturedHandlers[handlerKey].default;
    }

    it('should send new message with delaySeconds when handler returns timeoutSeconds', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 300 }); // 5 minutes

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      // Should return undefined (message will be deleted/acknowledged)
      expect(result).toBeUndefined();

      // Should have sent a new message with delaySeconds
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        '__wkf_workflow_test', // Underscores are preserved by sanitization
        expect.objectContaining({
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        }),
        expect.objectContaining({
          delaySeconds: 300,
        })
      );
    });

    it('should clamp delaySeconds to max 23 hours for long sleeps', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 100000 }); // ~27.8 hours

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      // Should return undefined (message will be deleted)
      expect(result).toBeUndefined();

      // Should have sent a new message with delaySeconds clamped to 82800 (23h)
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        '__wkf_workflow_test', // Underscores are preserved by sanitization
        expect.any(Object),
        expect.objectContaining({
          delaySeconds: 82800, // MAX_DELAY_SECONDS (23 hours)
        })
      );
    });

    it('should return undefined without sending when handler returns void', async () => {
      const handler = setupHandler(undefined);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      // Should return undefined (acknowledge message)
      expect(result).toBeUndefined();

      // Should NOT have sent a new message
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should preserve deploymentId when sending delayed message', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 3600 }); // 1 hour

      await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];
      expect(sentPayload.deploymentId).toBe('dpl_original');
    });

    it('should handle step payloads correctly', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 3600 }); // 1 hour

      const stepPayload = {
        workflowName: 'test-workflow',
        workflowRunId: 'run-123',
        workflowStartedAt: Date.now(),
        stepId: 'step-456',
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
      const sentPayload = mockSend.mock.calls[0][1];
      expect(sentPayload.payload).toEqual(stepPayload);
      expect(sentPayload.queueName).toBe('__wkf_step_myStep');
    });
  });
});
