import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @vercel/queue
const mockSend = vi.fn();
const mockHandleCallback = vi.fn();

vi.mock('@vercel/queue', () => ({
  Client: vi.fn().mockImplementation(() => ({
    send: mockSend,
    handleCallback: mockHandleCallback,
  })),
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

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'run-123' });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];

      expect(sentPayload.payload).toEqual({ runId: 'run-123' });
      expect(sentPayload.queueName).toBe('__wkf_workflow_test');
    });
  });

  describe('createQueueHandler()', () => {
    // Helper to simulate handleCallback behavior
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

    it('should pass through timeoutSeconds when message is fresh', async () => {
      const handler = setupHandler({ timeoutSeconds: 50000 });

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      // Should pass through unchanged since message is fresh
      expect(result).toEqual({ timeoutSeconds: 50000 });
      expect(mockSend).not.toHaveBeenCalled(); // No re-enqueue
    });

    it('should clamp timeoutSeconds when message has limited lifetime remaining', async () => {
      const handler = setupHandler({ timeoutSeconds: 7200 }); // 2 hours

      // Message that was created 22 hours ago
      // maxAllowedTimeout = 86400 - 3600 - 79200 = 3600s (1 hour)
      const oldMessageTime = new Date(Date.now() - 22 * 60 * 60 * 1000);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: oldMessageTime }
      );

      // Should clamp to maxAllowedTimeout (~3600s)
      expect(result).toBeDefined();
      expect((result as { timeoutSeconds: number }).timeoutSeconds).toBeCloseTo(
        3600,
        0
      );
      expect(mockSend).not.toHaveBeenCalled(); // No re-enqueue, just clamping
    });

    it('should re-enqueue when message has no lifetime remaining', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 3600 }); // 1 hour

      // Message that was created 23 hours ago (at the buffer limit)
      // maxAllowedTimeout = 86400 - 3600 - 82800 = 0s
      const oldMessageTime = new Date(Date.now() - 23 * 60 * 60 * 1000);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: oldMessageTime }
      );

      // Should return undefined (acknowledge old message)
      expect(result).toBeUndefined();

      // Should have re-enqueued
      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];
      expect(sentPayload.payload).toEqual({ runId: 'run-123' });
      expect(sentPayload.queueName).toBe('__wkf_workflow_test');
    });

    it('should not re-enqueue when message has enough lifetime remaining', async () => {
      const handler = setupHandler({ timeoutSeconds: 7200 }); // 2 hours

      // Message that was created 10 hours ago (plenty of time remaining)
      const messageTime = new Date(Date.now() - 10 * 60 * 60 * 1000);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: messageTime }
      );

      // Should return the timeout (not re-enqueue)
      expect(result).toEqual({ timeoutSeconds: 7200 });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should pass through result when no timeoutSeconds', async () => {
      const handler = setupHandler(undefined);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should handle step payloads correctly', async () => {
      mockSend.mockResolvedValue({ messageId: 'new-msg-123' });
      const handler = setupHandler({ timeoutSeconds: 3600 }); // 1 hour

      // Old message approaching expiry
      const oldMessageTime = new Date(Date.now() - 23 * 60 * 60 * 1000);

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
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: oldMessageTime }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];
      expect(sentPayload.payload).toEqual(stepPayload);
    });
  });
});
