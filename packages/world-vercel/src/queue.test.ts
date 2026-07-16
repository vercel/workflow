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
  // Must be a `function` (not an arrow): queue.ts calls `new QueueClient(...)`,
  // and an arrow function cannot be used as a constructor.
  // biome-ignore lint/complexity/useArrowFunction: needs to be newable
  const MockQueueClient = vi.fn().mockImplementation(function () {
    return {
      send: mockSend,
      handleCallback: mockHandleCallback,
    };
  });

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
import { getHttpUrl } from './utils.js';

describe('createQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('proxy region header', () => {
    it('sends x-vercel-queue-region when using the api.vercel.com proxy', async () => {
      // `./utils.js` is module-mocked with `usingProxy: false`; flip it to
      // proxy mode for this construction.
      vi.mocked(getHttpUrl).mockReturnValueOnce({
        baseUrl: 'https://api.vercel.com/v1/workflow',
        usingProxy: true,
      });
      mockSend.mockResolvedValue({ messageId: 'msg-123' });
      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
      try {
        const queue = createQueue({
          token: 'test-token',
          projectConfig: { projectId: 'prj_123', teamId: 'team_456' },
        });
        await queue.queue('__wkf_workflow_test', { runId: 'run-123' });
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const ctorArg = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
        headers?: Record<string, string>;
      };
      expect(ctorArg.headers?.['x-vercel-queue-region']).toBe(ctorArg.region);
      expect(ctorArg.headers?.['x-vercel-queue-region']).toBeDefined();
    });

    it('does not send x-vercel-queue-region on the direct (non-proxy) path', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });
      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
      try {
        const queue = createQueue();
        await queue.queue('__wkf_workflow_test', { runId: 'run-123' });
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const ctorArg = ctorCalls[ctorCalls.length - 1][0] as {
        headers?: Record<string, string>;
      };
      // Direct sends dial `<region>.vercel-queue.com` via the SDK's own
      // base-URL resolution; the header is proxy-only.
      expect(ctorArg.headers?.['x-vercel-queue-region']).toBeUndefined();
    });
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
        // send(topicName, wrapper, options) — CborTransport encodes
        // inside serialize(), but the mock bypasses the transport.
        const wrapper = mockSend.mock.calls[0][1];

        expect(wrapper.payload).toEqual({ runId: 'run-123' });
        expect(wrapper.queueName).toBe('__wkf_workflow_test');
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

    it('should auto-inject x-vercel-workflow-run-id header for workflow payloads', async () => {
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
              'x-vercel-workflow-run-id': 'wrun_abc123',
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

    it('should auto-inject x-vercel-workflow-run-id and x-vercel-workflow-step-id headers for step payloads', async () => {
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
              'x-vercel-workflow-run-id': 'wrun_abc123',
              'x-vercel-workflow-step-id': 'step_xyz789',
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
              'x-vercel-workflow-run-id': 'wrun_override',
              'x-custom-header': 'custom-value',
            },
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        // send(topicName, payload, options)
        const sendOpts = mockSend.mock.calls[0][2];
        expect(sendOpts.headers).toEqual({
          'x-vercel-workflow-run-id': 'wrun_override',
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

  describe('strict concurrency (WORKFLOW_SEQUENTIAL_REPLAYS)', () => {
    let originalDeploymentId: string | undefined;
    let originalStrict: string | undefined;

    beforeEach(() => {
      originalDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
      originalStrict = process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
      mockSend.mockResolvedValue({ messageId: 'msg-123' });
    });

    afterEach(() => {
      if (originalDeploymentId !== undefined) {
        process.env.VERCEL_DEPLOYMENT_ID = originalDeploymentId;
      } else {
        delete process.env.VERCEL_DEPLOYMENT_ID;
      }
      if (originalStrict !== undefined) {
        process.env.WORKFLOW_SEQUENTIAL_REPLAYS = originalStrict;
      } else {
        delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
      }
    });

    it('appends runId to the physical flow topic while keeping the logical queueName', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc' });

      // send(physicalTopic, wrapper, options)
      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_test_wrun_abc');
      // The logical queue name is preserved so the handler + re-enqueue path
      // resolves the same per-run physical topic on the next invocation.
      expect(mockSend.mock.calls[0][1].queueName).toBe('__wkf_workflow_test');
    });

    it('re-enqueues delayed flow messages to the same per-run physical topic', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

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
        timeoutSeconds: 300,
      }));

      await capturedHandler!(
        {
          payload: { runId: 'wrun_abc' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      );

      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_test_wrun_abc');
    });

    it('does not rewrite the topic when the flag is unset', async () => {
      delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc' });

      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_test');
    });

    it('does not rewrite step topics even when the flag is set', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      await queue.queue('__wkf_step_myStep', {
        workflowName: 'test-workflow',
        workflowRunId: 'wrun_abc',
        workflowStartedAt: Date.now(),
        stepId: 'step_xyz',
      });

      expect(mockSend.mock.calls[0][0]).toBe('__wkf_step_myStep');
    });

    it('gives inline step executions (flow topic + stepId) a per-step topic for full parallelism', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      // Inline step executions ride the flow topic as WorkflowInvokePayload
      // with a stepId. They must NOT share the per-run serialized topic, or
      // a run's parallel steps would execute one at a time.
      await queue.queue('__wkf_workflow_test', {
        runId: 'wrun_abc',
        stepId: 'step_one',
      });
      await queue.queue('__wkf_workflow_test', {
        runId: 'wrun_abc',
        stepId: 'step_two',
      });

      expect(mockSend.mock.calls[0][0]).toBe(
        '__wkf_workflow_test_wrun_abc_step_one'
      );
      expect(mockSend.mock.calls[1][0]).toBe(
        '__wkf_workflow_test_wrun_abc_step_two'
      );
      // The wrapper keeps the logical queue name for handler dispatch.
      expect(mockSend.mock.calls[0][1].queueName).toBe('__wkf_workflow_test');
    });

    it('gives each health check its own physical topic so concurrent probes never serialize', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      // Concurrent probes: with maxConcurrency: 1 applied per concrete topic,
      // a single shared `…_health_check` topic would process probes one at a
      // time and let a slow probe time out its successors. Distinct
      // per-correlation topics keep them independent.
      await queue.queue('__wkf_workflow_health_check', {
        __healthCheck: true as const,
        correlationId: 'corr_123',
      });
      await queue.queue('__wkf_workflow_health_check', {
        __healthCheck: true as const,
        correlationId: 'corr_456',
      });

      expect(mockSend.mock.calls[0][0]).toBe(
        '__wkf_workflow_health_check_corr_123'
      );
      expect(mockSend.mock.calls[1][0]).toBe(
        '__wkf_workflow_health_check_corr_456'
      );
      // The wrapper keeps the logical queue name for handler dispatch.
      expect(mockSend.mock.calls[0][1].queueName).toBe(
        '__wkf_workflow_health_check'
      );
    });

    it('does not rewrite health check topics when the flag is unset', async () => {
      delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;

      const queue = createQueue();
      await queue.queue('__wkf_workflow_health_check', {
        __healthCheck: true as const,
        correlationId: 'corr_123',
      });

      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_health_check');
    });

    it('does not rewrite step health check topics even when the flag is set', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      await queue.queue('__wkf_step_health_check', {
        __healthCheck: true as const,
        correlationId: 'corr_123',
      });

      expect(mockSend.mock.calls[0][0]).toBe('__wkf_step_health_check');
    });

    it('appends runId to namespaced flow topics so it composes with WORKFLOW_QUEUE_NAMESPACE', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      await queue.queue('__custom_wkf_workflow_test', { runId: 'wrun_abc' });

      expect(mockSend.mock.calls[0][0]).toBe(
        '__custom_wkf_workflow_test_wrun_abc'
      );
      expect(mockSend.mock.calls[0][1].queueName).toBe(
        '__custom_wkf_workflow_test'
      );
    });

    it('does not rewrite namespaced step topics even when the flag is set', async () => {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';

      const queue = createQueue();
      await queue.queue('__custom_wkf_step_myStep', {
        workflowName: 'test-workflow',
        workflowRunId: 'wrun_abc',
        workflowStartedAt: Date.now(),
        stepId: 'step_xyz',
      });

      expect(mockSend.mock.calls[0][0]).toBe('__custom_wkf_step_myStep');
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
      expect(mockHandleCallback).toHaveBeenCalledWith(expect.any(Function), {
        retry: expect.any(Function),
      });
    });

    it('should ask VQS to retry handler errors with bounded backoff', () => {
      mockHandleCallback.mockReturnValue(async () => new Response('ok'));
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      try {
        const queue = createQueue();
        queue.createQueueHandler('__wkf_workflow_', async () => undefined);

        const options = mockHandleCallback.mock.calls[0][1];
        const handlerError = new Error('workflow server unavailable');
        expect(
          options.retry(handlerError, {
            messageId: 'msg-123',
            deliveryCount: 1,
          })
        ).toEqual({ afterSeconds: 1 });
        expect(consoleErrorSpy).toHaveBeenLastCalledWith(
          '[workflow] Queue handler failed for message "msg-123" on delivery attempt 1; retrying in 1s:',
          handlerError
        );
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 2,
          })
        ).toEqual({ afterSeconds: 2 });
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 4,
          })
        ).toEqual({ afterSeconds: 8 });
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 8,
          })
        ).toEqual({ afterSeconds: 128 });
        // Ramps toward the 900s ceiling (VQS clamps each redelivery to its
        // 900s SQS limit) so a sustained outage spans most of the 24h window.
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 11,
          })
        ).toEqual({ afterSeconds: 900 });
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 20,
          })
        ).toEqual({ afterSeconds: 900 });

        randomSpy.mockReturnValue(0.999);
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 4,
          })
        ).toEqual({ afterSeconds: 6 });
        expect(
          options.retry(new Error('workflow server unavailable'), {
            messageId: 'msg-123',
            deliveryCount: 8,
          })
        ).toEqual({ afterSeconds: 96 });
      } finally {
        randomSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      }
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

    it('should send new message without delaySeconds when handler returns timeoutSeconds: 0', async () => {
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
          timeoutSeconds: 0,
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
        expect(sendOpts.delaySeconds).toBeUndefined();
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

    it('should auto-inject x-vercel-workflow-run-id header on delayed re-enqueue', async () => {
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
            'x-vercel-workflow-run-id': 'wrun_abc123',
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
            'x-vercel-workflow-run-id': 'wrun_abc123',
            'x-vercel-workflow-step-id': 'step_xyz789',
          }),
        })
      );
    });

    it('should pass x-vercel-id as requestId in handler metadata', async () => {
      let capturedMeta: any;
      mockHandleCallback.mockImplementation((handler) => {
        // Return a function that simulates VQS invoking the handler
        return async (req: Request) => {
          await handler(
            {
              payload: { runId: 'run-123' },
              queueName: '__wkf_workflow_test',
            },
            {
              messageId: 'msg-123',
              deliveryCount: 1,
              createdAt: new Date(),
            }
          );
          return new Response('ok');
        };
      });

      const queue = createQueue();
      const routeHandler = queue.createQueueHandler(
        '__wkf_workflow_',
        async (_msg, meta) => {
          capturedMeta = meta;
        }
      );

      await routeHandler(
        new Request('http://localhost', {
          headers: { 'x-vercel-id': 'iad1::abc123' },
        })
      );

      expect(capturedMeta.requestId).toBe('iad1::abc123');
    });

    it('should pass undefined requestId when x-vercel-id header is absent', async () => {
      let capturedMeta: any;
      mockHandleCallback.mockImplementation((handler) => {
        return async (req: Request) => {
          await handler(
            {
              payload: { runId: 'run-123' },
              queueName: '__wkf_workflow_test',
            },
            {
              messageId: 'msg-123',
              deliveryCount: 1,
              createdAt: new Date(),
            }
          );
          return new Response('ok');
        };
      });

      const queue = createQueue();
      const routeHandler = queue.createQueueHandler(
        '__wkf_workflow_',
        async (_msg, meta) => {
          capturedMeta = meta;
        }
      );

      await routeHandler(new Request('http://localhost'));

      expect(capturedMeta.requestId).toBeUndefined();
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
        // send(topicName, wrapper, options) — CborTransport encodes
        // inside serialize(), but the mock bypasses the transport.
        const wrapper = mockSend.mock.calls[0][1];
        expect(wrapper.payload).toEqual(stepPayload);
        expect(wrapper.queueName).toBe('__wkf_step_myStep');
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        } else {
          delete process.env.VERCEL_DEPLOYMENT_ID;
        }
      }
    });
  });

  describe('region routing', () => {
    const originalDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    const originalRegion = process.env.VERCEL_REGION;

    beforeEach(() => {
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
      delete process.env.VERCEL_REGION;
      mockSend.mockResolvedValue({ messageId: 'msg-123' });
    });

    afterEach(() => {
      if (originalDeploymentId !== undefined) {
        process.env.VERCEL_DEPLOYMENT_ID = originalDeploymentId;
      } else {
        delete process.env.VERCEL_DEPLOYMENT_ID;
      }
      if (originalRegion !== undefined) {
        process.env.VERCEL_REGION = originalRegion;
      } else {
        delete process.env.VERCEL_REGION;
      }
    });

    it('uses an explicit `opts.region` override', async () => {
      const queue = createQueue();
      await queue.queue(
        '__wkf_workflow_test',
        { runId: 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        { region: 'fra1' }
      );

      // `queue()` constructs a fresh QueueClient per send (with region);
      // grab the most recent construction in case other clients (e.g. the
      // handler's, which omits region) were constructed earlier.
      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('fra1');
    });

    it('extracts the region from a tagged workflow run ID payload', async () => {
      // Build a tagged run ID for `sfo1` (regionId=2). We do this by
      // calling encode() via the public sub-export so the test stays
      // resilient to bit-layout changes.
      const { encode } = await import('./run-id/index.js');
      const runId = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'sfo1')}`;

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('sfo1');
    });

    it('extracts the region from a tagged step payload workflowRunId', async () => {
      const { encode } = await import('./run-id/index.js');
      const workflowRunId = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'pdx1')}`;

      const queue = createQueue();
      await queue.queue('__wkf_step_test', {
        workflowName: 'wf',
        workflowRunId,
        workflowStartedAt: Date.now(),
        stepId: 'step-1',
      });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('pdx1');
    });

    it('falls back to VERCEL_REGION for un-tagged run IDs', async () => {
      process.env.VERCEL_REGION = 'cle1';

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_untagged' });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('cle1');
    });

    it('falls back to iad1 when neither tagging nor VERCEL_REGION is available', async () => {
      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_untagged' });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('iad1');
    });

    it('falls back to iad1 for health-check payloads (no runId)', async () => {
      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', {
        __healthCheck: true,
        correlationId: 'health-1',
      });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('iad1');
    });

    it('prefers `opts.region` over a payload-derived region', async () => {
      const { encode } = await import('./run-id/index.js');
      const runId = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'sfo1')}`;

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId }, { region: 'fra1' });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('fra1');
    });

    it('ignores an unrecognised `opts.region`, falling through to the tagged run ID', async () => {
      const { encode } = await import('./run-id/index.js');
      const runId = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'sfo1')}`;

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId }, { region: 'xyz9' });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('sfo1');
    });

    it('ignores an unrecognised VERCEL_REGION, falling back to iad1', async () => {
      process.env.VERCEL_REGION = 'nope1';

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_untagged' });

      const ctorCalls = (
        MockQueueClient as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const sendTimeCall = ctorCalls[ctorCalls.length - 1][0] as {
        region?: string;
      };
      expect(sendTimeCall.region).toBe('iad1');
    });
  });
});
