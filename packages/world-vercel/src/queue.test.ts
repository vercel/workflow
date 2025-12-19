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
    it('should include messageQueuedAt in the message', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const queue = createQueue();
      const beforeTime = Date.now();

      await queue.queue('__wkf_workflow_test', { runId: 'run-123' });

      const afterTime = Date.now();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];

      expect(sentPayload.messageQueuedAt).toBeDefined();
      const queuedAt = new Date(sentPayload.messageQueuedAt).getTime();
      expect(queuedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(queuedAt).toBeLessThanOrEqual(afterTime);
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
          messageQueuedAt: new Date(), // Fresh message
        },
        { messageId: 'msg-123', deliveryCount: 1 }
      );

      // Should pass through unchanged since message is fresh
      expect(result).toEqual({ timeoutSeconds: 50000 });
      expect(mockSend).not.toHaveBeenCalled(); // No re-enqueue
    });

    it('should clamp timeoutSeconds when message has limited lifetime remaining', async () => {
      const handler = setupHandler({ timeoutSeconds: 7200 }); // 2 hours

      // Message that was queued 22 hours ago
      // maxAllowedTimeout = 86400 - 3600 - 79200 = 3600s (1 hour)
      const oldMessageTime = new Date(Date.now() - 22 * 60 * 60 * 1000);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          messageQueuedAt: oldMessageTime,
        },
        { messageId: 'msg-123', deliveryCount: 1 }
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

      // Message that was queued 23 hours ago (at the buffer limit)
      // maxAllowedTimeout = 86400 - 3600 - 82800 = 0s
      const oldMessageTime = new Date(Date.now() - 23 * 60 * 60 * 1000);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          messageQueuedAt: oldMessageTime,
        },
        { messageId: 'msg-123', deliveryCount: 1 }
      );

      // Should return undefined (acknowledge old message)
      expect(result).toBeUndefined();

      // Should have re-enqueued
      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];
      expect(sentPayload.payload).toEqual({ runId: 'run-123' });
      expect(sentPayload.queueName).toBe('__wkf_workflow_test');
      // New message should have fresh timestamp
      expect(new Date(sentPayload.messageQueuedAt).getTime()).toBeGreaterThan(
        oldMessageTime.getTime()
      );
    });

    it('should not re-enqueue when message has enough lifetime remaining', async () => {
      const handler = setupHandler({ timeoutSeconds: 7200 }); // 2 hours

      // Message that was queued 10 hours ago (plenty of time remaining)
      const messageTime = new Date(Date.now() - 10 * 60 * 60 * 1000);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          messageQueuedAt: messageTime,
        },
        { messageId: 'msg-123', deliveryCount: 1 }
      );

      // Should return the timeout (not re-enqueue)
      expect(result).toEqual({ timeoutSeconds: 7200 });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should handle messages without messageQueuedAt (backwards compatibility)', async () => {
      const handler = setupHandler({ timeoutSeconds: 50000 });

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          // No messageQueuedAt - old message format
        },
        { messageId: 'msg-123', deliveryCount: 1 }
      );

      // Should treat as fresh message (age = 0) and pass through
      expect(result).toEqual({ timeoutSeconds: 50000 });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should pass through result when no timeoutSeconds', async () => {
      const handler = setupHandler(undefined);

      const result = await handler(
        {
          payload: { runId: 'run-123' },
          queueName: '__wkf_workflow_test',
          messageQueuedAt: new Date(),
        },
        { messageId: 'msg-123', deliveryCount: 1 }
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
          messageQueuedAt: oldMessageTime,
        },
        { messageId: 'msg-123', deliveryCount: 1 }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentPayload = mockSend.mock.calls[0][1];
      expect(sentPayload.payload).toEqual(stepPayload);
    });
  });
});
