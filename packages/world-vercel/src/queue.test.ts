import { context, trace as otelTrace, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const {
  mockSend,
  mockSendBatch,
  MockConsumerDiscoveryError,
  MockQueueClient,
  mockHandleCallback,
} = vi.hoisted(() => {
  class MockConsumerDiscoveryError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConsumerDiscoveryError';
    }
  }

  const mockSend = vi.fn();
  const mockSendBatch = vi.fn();
  const mockHandleCallback = vi.fn();
  // Must be a `function` (not an arrow): queue.ts calls `new QueueClient(...)`,
  // and an arrow function cannot be used as a constructor.
  // biome-ignore lint/complexity/useArrowFunction: needs to be newable
  const MockQueueClient = vi.fn().mockImplementation(function () {
    return {
      send: mockSend,
      experimental_sendBatch: mockSendBatch,
      handleCallback: mockHandleCallback,
    };
  });

  return {
    mockSend,
    mockSendBatch,
    MockConsumerDiscoveryError,
    MockQueueClient,
    mockHandleCallback,
  };
});

vi.mock('@vercel/queue', () => ({
  QueueClient: MockQueueClient,
  ConsumerDiscoveryError: MockConsumerDiscoveryError,
}));

vi.mock('./utils.js', () => ({
  getHttpUrl: vi
    .fn()
    .mockReturnValue({ baseUrl: 'http://localhost:3000', usingProxy: false }),
  getHeaders: vi.fn().mockReturnValue(new Map()),
}));

import { missingDeploymentIdMessage } from './deployment-id.js';
import {
  createQueue,
  recordStepExecution,
  resolveMessageLifetime,
} from './queue.js';
import { getHttpUrl } from './utils.js';

describe('createQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('classifies only consumer discovery failures as unavailable deployments', () => {
    const queue = createQueue();

    expect(
      queue.isDeploymentUnavailableError?.(
        new MockConsumerDiscoveryError('deployment not found')
      )
    ).toBe(true);
    expect(
      queue.isDeploymentUnavailableError?.(new Error('transient send failure'))
    ).toBe(false);
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
          missingDeploymentIdMessage('Enqueuing a workflow message')
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.VERCEL_DEPLOYMENT_ID = originalEnv;
        }
      }
    });

    it('should throw an actionable error from getDeploymentId, which start() calls before writing any state', async () => {
      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      delete process.env.VERCEL_DEPLOYMENT_ID;

      try {
        await expect(createQueue().getDeploymentId()).rejects.toThrow(
          missingDeploymentIdMessage('Starting a workflow run')
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

    it('returns the message id for a repeated idempotency key', async () => {
      // Repeated keys are accepted and deduplicated after the send, so the
      // caller sees an ordinary message id rather than a conflict.
      mockSend.mockResolvedValue({ messageId: 'msg-456' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        const result = await queue.queue(
          '__wkf_workflow_test',
          { runId: 'run-123' },
          { idempotencyKey: 'my-key' }
        );

        expect(result.messageId).toBe('msg-456');
        expect(mockSend).toHaveBeenCalledWith(
          expect.any(String),
          expect.anything(),
          expect.objectContaining({ idempotencyKey: 'my-key' })
        );
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

    it('should auto-inject run and step headers for inline step payloads', async () => {
      mockSend.mockResolvedValue({ messageId: 'msg-123' });

      const originalEnv = process.env.VERCEL_DEPLOYMENT_ID;
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';

      try {
        const queue = createQueue();
        await queue.queue('__wkf_workflow_test', {
          runId: 'wrun_abc123',
          stepId: 'step_xyz789',
          stepName: 'myStep',
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

  describe('per-run orchestrator topics', () => {
    beforeEach(() => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
      mockSend.mockResolvedValue({ messageId: 'msg-123' });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('routes orchestrator messages to a per-run topic with no opt-in', async () => {
      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc' });
      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_test_wrun_abc');
    });

    it('ignores the removed WORKFLOW_SEQUENTIAL_REPLAYS=0', async () => {
      vi.stubEnv('WORKFLOW_SEQUENTIAL_REPLAYS', '0');
      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc' });
      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_test_wrun_abc');
    });

    it('appends runId to the physical flow topic while keeping the logical queueName', async () => {
      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc' });

      // send(physicalTopic, wrapper, options)
      expect(mockSend.mock.calls[0][0]).toBe('__wkf_workflow_test_wrun_abc');
      // The logical queue name is preserved so the handler + re-enqueue path
      // resolves the same per-run physical topic on the next invocation.
      expect(mockSend.mock.calls[0][1].queueName).toBe('__wkf_workflow_test');
    });

    it('gives inline step executions (flow topic + stepId) a per-step topic for full parallelism', async () => {
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

    it('keeps a per-probe topic for a health check that carries a runId', async () => {
      const queue = createQueue();
      // A probe issued to prepare a cross-deployment `start()` carries the run
      // id it is about to create. It must still get its per-probe topic rather
      // than being routed to that run's serialized replay topic, which would
      // queue the probe behind the run it is trying to prepare.
      await queue.queue('__wkf_workflow_health_check', {
        __healthCheck: true as const,
        correlationId: 'corr_123',
        runId: 'wrun_abc',
      });

      expect(mockSend.mock.calls[0][0]).toBe(
        '__wkf_workflow_health_check_corr_123'
      );
      // The payload must survive intact so the handler dispatches it as a
      // health check rather than as a workflow invoke.
      expect(mockSend.mock.calls[0][1].payload).toEqual({
        __healthCheck: true,
        correlationId: 'corr_123',
        runId: 'wrun_abc',
      });
    });

    it('appends runId to namespaced flow topics so it composes with WORKFLOW_QUEUE_NAMESPACE', async () => {
      const queue = createQueue();
      await queue.queue('__custom_wkf_workflow_test', { runId: 'wrun_abc' });

      expect(mockSend.mock.calls[0][0]).toBe(
        '__custom_wkf_workflow_test_wrun_abc'
      );
      expect(mockSend.mock.calls[0][1].queueName).toBe(
        '__custom_wkf_workflow_test'
      );
    });
  });

  describe('message keys and lifetime', () => {
    beforeEach(() => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
      mockSend.mockResolvedValue({ messageId: 'msg-123' });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('sends a wake with no idempotency key and no retention', async () => {
      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', { runId: 'wrun_abc' });
      const sendOpts = mockSend.mock.calls[0][2];
      expect(sendOpts.idempotencyKey).toBeUndefined();
      expect(sendOpts).not.toHaveProperty('retentionSeconds');
      expect(sendOpts).not.toHaveProperty('delaySeconds');
    });

    it('sends a step message with its stable key and retention', async () => {
      const queue = createQueue();
      const retentionSeconds = 3 * 24 * 60 * 60;
      await queue.queue(
        '__wkf_workflow_test',
        { runId: 'wrun_abc', stepId: 'step_1', stepName: 'add' },
        { idempotencyKey: 'step_1', retentionSeconds }
      );
      const [topic, , sendOpts] = mockSend.mock.calls[0];
      expect(topic).toBe('__wkf_workflow_test_wrun_abc_step_1');
      expect(sendOpts).toMatchObject({
        idempotencyKey: 'step_1',
        retentionSeconds,
      });
    });

    it('sends the same key for every send of one step, so a re-enqueue dedupes', async () => {
      const queue = createQueue();
      const payload = { runId: 'wrun_abc', stepId: 'step_1', stepName: 'add' };
      await queue.queue('__wkf_workflow_test', payload, {
        idempotencyKey: 'step_1',
      });
      await queue.queue('__wkf_workflow_test', payload, {
        idempotencyKey: 'step_1',
      });
      expect(mockSend.mock.calls[0][0]).toBe(mockSend.mock.calls[1][0]);
      expect(mockSend.mock.calls[0][2].idempotencyKey).toBe(
        mockSend.mock.calls[1][2].idempotencyKey
      );
    });
  });

  describe('resolveMessageLifetime', () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60;
    const DEFAULT_MAX_DELAY = resolveMessageLifetime({
      delaySeconds: Number.MAX_SAFE_INTEGER,
    }).delaySeconds as number;

    it('sends neither field when the caller sets neither', () => {
      expect(resolveMessageLifetime()).toEqual({});
      expect(resolveMessageLifetime({ delaySeconds: 0 })).toEqual({});
    });

    it('keeps a timer inside the default retention when no retention is set', () => {
      expect(DEFAULT_MAX_DELAY).toBeLessThan(24 * 60 * 60);
      expect(resolveMessageLifetime({ delaySeconds: 300 })).toEqual({
        delaySeconds: 300,
      });
      expect(
        resolveMessageLifetime({ delaySeconds: DEFAULT_MAX_DELAY + 1 })
      ).toEqual({ delaySeconds: DEFAULT_MAX_DELAY });
    });

    it('caps retention at the queue maximum and floors it at the minimum', () => {
      expect(
        resolveMessageLifetime({ retentionSeconds: SEVEN_DAYS * 2 })
      ).toEqual({ retentionSeconds: SEVEN_DAYS });
      expect(resolveMessageLifetime({ retentionSeconds: 1 })).toEqual({
        retentionSeconds: 60,
      });
      expect(resolveMessageLifetime({ retentionSeconds: 90.2 })).toEqual({
        retentionSeconds: 91,
      });
    });

    it('lets a delayed message with retention use the retention, keeping the delay below it', () => {
      const lifetime = resolveMessageLifetime({
        retentionSeconds: SEVEN_DAYS,
        delaySeconds: SEVEN_DAYS,
      });
      expect(lifetime.retentionSeconds).toBe(SEVEN_DAYS);
      expect(lifetime.delaySeconds).toBeGreaterThan(DEFAULT_MAX_DELAY);
      expect(lifetime.delaySeconds).toBeLessThan(SEVEN_DAYS);
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

    it('should pass handler rejections to QueueClient', async () => {
      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });
      const handlerError = new Error('retry delivery');

      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async () => {
        throw handlerError;
      });

      assert(capturedHandler);
      await expect(
        capturedHandler(
          {
            payload: { runId: 'run-123' },
            queueName: '__wkf_workflow_test',
          },
          { messageId: 'msg-123', deliveryCount: 1 }
        )
      ).rejects.toBe(handlerError);
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

        // A server-directed lower bound wins over both the ordinary 1s first
        // retry and downward jitter. These are the typed errors produced by
        // HTTP and WS response mapping before they reach this final boundary.
        for (const error of [
          new ThrottleError('slow down', { retryAfter: 120 }),
          new TooEarlyError('not yet', { retryAfter: 120 }),
          new WorkflowWorldError('transport busy', {
            code: 'TRANSPORT',
            retryAfter: 120,
          }),
        ]) {
          expect(
            options.retry(error, {
              messageId: 'msg-123',
              deliveryCount: 1,
            })
          ).toEqual({ afterSeconds: 120 });
        }
        // The existing exponential policy still wins when it is longer.
        expect(
          options.retry(new ThrottleError('slow down', { retryAfter: 120 }), {
            messageId: 'msg-123',
            deliveryCount: 9,
          })
        ).toEqual({ afterSeconds: 192 });

        // Constructor identity is not reliable across VM/bundler realms. The
        // final boundary deliberately recognizes a usable numeric field.
        expect(
          options.retry(
            { name: 'ThrottleError', retryAfter: 120.1 },
            { messageId: 'msg-123', deliveryCount: 1 }
          )
        ).toEqual({ afterSeconds: 121 });
        expect(
          options.retry(
            { name: 'ThrottleError', retryAfter: Number.NaN },
            { messageId: 'msg-123', deliveryCount: 1 }
          )
        ).toEqual({ afterSeconds: 1 });
        expect(
          options.retry(
            { name: 'ThrottleError', retryAfter: 1_200 },
            { messageId: 'msg-123', deliveryCount: 1 }
          )
        ).toEqual({ afterSeconds: 900 });
      } finally {
        randomSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      }
    });

    it('redelivers the SAME message when the handler returns timeoutSeconds, sending nothing new', async () => {
      const handler = setupHandler({ timeoutSeconds: 300 });
      const thrown = await handler(
        {
          payload: { runId: 'run-123', stepId: 'step-1', stepName: 'myStep' },
          queueName: '__wkf_workflow_test',
          deploymentId: 'dpl_original',
        },
        { messageId: 'msg-123', deliveryCount: 2, createdAt: new Date() }
      ).catch((err: unknown) => err);

      // No replacement message: the current one stays unacknowledged.
      expect(mockSend).not.toHaveBeenCalled();
      // The callback's retry hook turns the signal into a redelivery of the
      // same message after the requested delay, without the failure log.
      const options = mockHandleCallback.mock.calls[0][1];
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      try {
        expect(
          options.retry(thrown, { messageId: 'msg-123', deliveryCount: 2 })
        ).toEqual({ afterSeconds: 300 });
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it.each([
      { timeoutSeconds: 0, afterSeconds: 0 },
      { timeoutSeconds: 2.2, afterSeconds: 3 },
      { timeoutSeconds: -5, afterSeconds: 0 },
      { timeoutSeconds: 100000, afterSeconds: 100000 },
    ])('asks for a redelivery after $afterSeconds s for timeoutSeconds $timeoutSeconds', async ({
      timeoutSeconds,
      afterSeconds,
    }) => {
      const handler = setupHandler({ timeoutSeconds });
      const thrown = await handler(
        { payload: { runId: 'run-123' }, queueName: '__wkf_workflow_test' },
        { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
      ).catch((err: unknown) => err);
      const options = mockHandleCallback.mock.calls[0][1];
      expect(
        options.retry(thrown, { messageId: 'msg-123', deliveryCount: 1 })
      ).toEqual({ afterSeconds });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('acknowledges an invoke request even when its result carries timeoutSeconds', async () => {
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
        timeoutSeconds: 5,
      }));
      await expect(
        capturedHandler!(
          {
            payload: { runId: 'run-123', invoke: true },
            queueName: '__wkf_workflow_test',
          },
          { messageId: 'msg-123', deliveryCount: 1, createdAt: new Date() }
        )
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('passes messageId, deliveryCount and createdAt through to the handler', async () => {
      let capturedMeta: Record<string, unknown> | undefined;
      let capturedHandler: (
        message: unknown,
        metadata: unknown
      ) => Promise<void>;
      mockHandleCallback.mockImplementation((handler) => {
        capturedHandler = handler;
        return async () => new Response('ok');
      });
      const queue = createQueue();
      queue.createQueueHandler('__wkf_workflow_', async (_message, meta) => {
        capturedMeta = meta as unknown as Record<string, unknown>;
      });
      const createdAt = new Date('2026-10-05T00:00:00.000Z');
      await capturedHandler!(
        { payload: { runId: 'run-123' }, queueName: '__wkf_workflow_test' },
        { messageId: 'msg-123', deliveryCount: 3, createdAt }
      );
      expect(capturedMeta).toMatchObject({
        messageId: 'msg-123',
        deliveryCount: 3,
        attempt: 3,
        createdAt,
      });
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

    it('reports the step IDs executed by a flow request', async () => {
      mockHandleCallback.mockImplementation((handler) => {
        return async () => {
          await handler(
            {
              payload: { runId: 'run-123' },
              queueName: '__wkf_workflow_test',
            },
            { messageId: 'msg-123', deliveryCount: 1 }
          );
          return new Response('ok');
        };
      });

      const routeHandler = createQueue().createQueueHandler(
        '__wkf_workflow_',
        async () => {
          recordStepExecution('step-a');
          recordStepExecution('step-b');
          recordStepExecution('step-a');
        }
      );

      const response = await routeHandler(new Request('http://localhost'));

      expect(response.headers.get('x-vercel-internal-workflow-step-ids')).toBe(
        JSON.stringify(['step-a', 'step-b'])
      );
    });

    it('reports at most 10 unique step IDs per flow request', async () => {
      mockHandleCallback.mockImplementation((handler) => {
        return async () => {
          await handler(
            {
              payload: { runId: 'run-123' },
              queueName: '__wkf_workflow_test',
            },
            { messageId: 'msg-123', deliveryCount: 1 }
          );
          return new Response('ok');
        };
      });

      const stepIds = Array.from({ length: 12 }, (_, index) => `step-${index}`);
      const routeHandler = createQueue().createQueueHandler(
        '__wkf_workflow_',
        async () => {
          for (const stepId of stepIds) recordStepExecution(stepId);
          recordStepExecution(stepIds[0]);
        }
      );

      const response = await routeHandler(new Request('http://localhost'));

      expect(response.headers.get('x-vercel-internal-workflow-step-ids')).toBe(
        JSON.stringify(stepIds.slice(0, 10))
      );
    });

    it('isolates step IDs between concurrent flow requests', async () => {
      mockHandleCallback.mockImplementation((handler) => {
        return async (request: Request) => {
          const runId = new URL(request.url).pathname.slice(1);
          await handler(
            {
              payload: { runId },
              queueName: '__wkf_workflow_test',
            },
            { messageId: `msg-${runId}`, deliveryCount: 1 }
          );
          return new Response('ok');
        };
      });

      const firstStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const routeHandler = createQueue().createQueueHandler(
        '__wkf_workflow_',
        async (payload) => {
          if ('runId' in payload && payload.runId === 'run-first') {
            recordStepExecution('step-first');
            firstStarted.resolve();
            await releaseFirst.promise;
          } else {
            recordStepExecution('step-second');
          }
        }
      );

      const firstResponse = routeHandler(
        new Request('http://localhost/run-first')
      );
      await firstStarted.promise;
      const secondResponse = routeHandler(
        new Request('http://localhost/run-second')
      );
      releaseFirst.resolve();

      const [first, second] = await Promise.all([
        firstResponse,
        secondResponse,
      ]);
      expect(first.headers.get('x-vercel-internal-workflow-step-ids')).toBe(
        JSON.stringify(['step-first'])
      );
      expect(second.headers.get('x-vercel-internal-workflow-step-ids')).toBe(
        JSON.stringify(['step-second'])
      );
    });

    it('keeps the scalar step delivery path unchanged', async () => {
      mockHandleCallback.mockImplementation((handler) => {
        return async () => {
          await handler(
            {
              payload: { runId: 'run-123', stepId: 'step-a' },
              queueName: '__wkf_workflow_test',
            },
            { messageId: 'msg-123', deliveryCount: 1 }
          );
          return new Response('ok');
        };
      });

      const routeHandler = createQueue().createQueueHandler(
        '__wkf_workflow_',
        async () => {
          recordStepExecution('step-a');
        }
      );

      const response = await routeHandler(new Request('http://localhost'));

      expect(
        response.headers.get('x-vercel-internal-workflow-step-ids')
      ).toBeNull();
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

    it('extracts the region from a tagged inline step payload runId', async () => {
      const { encode } = await import('./run-id/index.js');
      const runId = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'pdx1')}`;

      const queue = createQueue();
      await queue.queue('__wkf_workflow_test', {
        runId,
        stepId: 'step-1',
        stepName: 'myStep',
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

describe('queueBatch', () => {
  const RUN = 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const sent = (id: string) => ({ status: 'sent' as const, messageId: id });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_batch';
  });
  afterEach(() => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
  });

  // Messages for one run's orchestrator topic, so they share a physical
  // topic and can be grouped into one batch request.
  const entries = (n: number, runId = RUN) =>
    Array.from({ length: n }, (_, i) => ({
      message: { runId },
      opts: { idempotencyKey: `key-${i}` },
    }));

  it('sends each step message of a fan-out to its own per-step topic', async () => {
    mockSendBatch.mockResolvedValue([sent('m')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    await queue.queueBatch(
      '__wkf_workflow_test',
      Array.from({ length: 3 }, (_, i) => ({
        message: { runId: RUN, stepId: `step-${i}`, stepName: 'myStep' },
        opts: { idempotencyKey: `step-${i}` },
      }))
    );

    expect(mockSendBatch).toHaveBeenCalledTimes(3);
    expect(mockSendBatch.mock.calls.map(([topic]) => topic).sort()).toEqual([
      `__wkf_workflow_test_${RUN}_step-0`,
      `__wkf_workflow_test_${RUN}_step-1`,
      `__wkf_workflow_test_${RUN}_step-2`,
    ]);
  });

  // A build that registered the step trigger: the whole fan-out shares one
  // topic, so it goes out in one request.
  it('sends a fan-out to the shared step topic in one request when the build registered it', async () => {
    mockSendBatch.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => sent(`m${i}`))
    );
    const queue = createQueue();
    assert(queue.queueBatch);

    await queue.queueBatch(
      '__wkf_workflow_test',
      Array.from({ length: 3 }, (_, i) => ({
        message: { runId: RUN, stepId: `step-${i}`, stepName: 'myStep' },
        opts: { idempotencyKey: `step-${i}`, stepTopic: true },
      }))
    );

    expect(mockSendBatch).toHaveBeenCalledTimes(1);
    const [topic, messages] = mockSendBatch.mock.calls[0];
    expect(topic).toBe('__wkf_step_test');
    expect(messages).toHaveLength(3);
    // The wrapper keeps the logical queue name for handler dispatch.
    expect(messages[0].payload.queueName).toBe('__wkf_workflow_test');
  });

  it('keeps per-step topics for a message routed to another deployment', async () => {
    mockSendBatch.mockResolvedValue([sent('m')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    await queue.queueBatch('__wkf_workflow_test', [
      {
        message: { runId: RUN, stepId: 'step-0', stepName: 'myStep' },
        opts: {
          idempotencyKey: 'step-0',
          stepTopic: true,
          deploymentId: 'dpl_other',
        },
      },
    ]);

    expect(mockSendBatch.mock.calls[0][0]).toBe(
      `__wkf_workflow_test_${RUN}_step-0`
    );
  });

  it('keeps per-step topics when WORKFLOW_SHARED_STEP_TOPIC=0', async () => {
    vi.stubEnv('WORKFLOW_SHARED_STEP_TOPIC', '0');
    mockSendBatch.mockResolvedValue([sent('m')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    await queue.queueBatch('__wkf_workflow_test', [
      {
        message: { runId: RUN, stepId: 'step-0', stepName: 'myStep' },
        opts: { idempotencyKey: 'step-0', stepTopic: true },
      },
    ]);

    expect(mockSendBatch.mock.calls[0][0]).toBe(
      `__wkf_workflow_test_${RUN}_step-0`
    );
    vi.unstubAllEnvs();
  });

  it('scopes the shared step topic to the queue namespace', async () => {
    mockSendBatch.mockResolvedValue([sent('m')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    await queue.queueBatch('__eve_wkf_workflow_test', [
      {
        message: { runId: RUN, stepId: 'step-0', stepName: 'myStep' },
        opts: { idempotencyKey: 'step-0', stepTopic: true },
      },
    ]);

    expect(mockSendBatch.mock.calls[0][0]).toBe('__eve_wkf_step_test');
  });

  // Orchestrator messages keep their per-run topic.
  it('ignores stepTopic on a message without a stepId', async () => {
    mockSendBatch.mockResolvedValue([sent('m')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    await queue.queueBatch('__wkf_workflow_test', [
      { message: { runId: RUN }, opts: { stepTopic: true } },
    ]);

    expect(mockSendBatch.mock.calls[0][0]).toBe(`__wkf_workflow_test_${RUN}`);
  });

  it('publishes a whole fan-out in one request and preserves input order', async () => {
    mockSendBatch.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => sent(`m${i}`))
    );
    const queue = createQueue();
    assert(queue.queueBatch);

    const results = await queue.queueBatch('__wkf_workflow_test', entries(5));

    expect(mockSendBatch).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
    const [topic, messages] = mockSendBatch.mock.calls[0];
    expect(topic).toBe(`__wkf_workflow_test_${RUN}`);
    expect(messages).toHaveLength(5);
    // Each message keeps its own idempotency key: the recovery for a failed
    // batch is to republish it, which must not redeliver what already landed.
    expect(
      messages.map((m: { idempotencyKey?: string }) => m.idempotencyKey)
    ).toEqual(['key-0', 'key-1', 'key-2', 'key-3', 'key-4']);
    expect(results.map((r) => r.messageId)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('splits at the 100-message VQS cap', async () => {
    mockSendBatch
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => sent(`a${i}`))
      )
      .mockResolvedValueOnce(
        Array.from({ length: 40 }, (_, i) => sent(`b${i}`))
      );
    const queue = createQueue();
    assert(queue.queueBatch);

    const results = await queue.queueBatch('__wkf_workflow_test', entries(140));

    expect(mockSendBatch).toHaveBeenCalledTimes(2);
    expect(mockSendBatch.mock.calls[0][1]).toHaveLength(100);
    expect(mockSendBatch.mock.calls[1][1]).toHaveLength(40);
    // The split must not be observable in the returned order.
    expect(results).toHaveLength(140);
    expect(results[0].messageId).toBe('a0');
    expect(results[99].messageId).toBe('a99');
    expect(results[100].messageId).toBe('b0');
    expect(results[139].messageId).toBe('b39');
  });

  it('reports per-entry failures without rejecting', async () => {
    mockSendBatch.mockResolvedValueOnce([
      sent('m0'),
      {
        status: 'failed',
        statusCode: 429,
        error: 'rate limited',
        retryable: true,
      },
      { status: 'deferred', messageId: null },
    ]);
    const queue = createQueue();
    assert(queue.queueBatch);

    const results = await queue.queueBatch('__wkf_workflow_test', entries(3));

    expect(results[0]).toEqual({ messageId: 'm0' });
    expect(results[1]).toEqual({
      messageId: null,
      error: 'rate limited',
      retryable: true,
    });
    // Deferred is an acceptance, not a failure: no `error`, so callers that
    // test `error === undefined` treat it as sent.
    expect(results[2]).toEqual({ messageId: null });
  });

  it('flags a short result array as a retryable per-entry failure', async () => {
    mockSendBatch.mockResolvedValueOnce([sent('m0')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    const results = await queue.queueBatch('__wkf_workflow_test', entries(2));

    expect(results[0]).toEqual({ messageId: 'm0' });
    expect(results[1]?.error).toMatch(/no result/i);
    assert(results[1]?.error !== undefined);
    expect(results[1].retryable).toBe(true);
  });

  it('routes messages for different regions through separate requests', async () => {
    const { encode } = await import('./run-id/index.js');
    const sfo = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'sfo1')}`;
    const fra = `wrun_${encode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'fra1')}`;
    mockSendBatch.mockResolvedValue([sent('x'), sent('y')]);
    const queue = createQueue();
    assert(queue.queueBatch);

    const results = await queue.queueBatch('__wkf_workflow_test', [
      ...entries(2, sfo),
      ...entries(2, fra),
    ]);

    expect(mockSendBatch).toHaveBeenCalledTimes(2);
    const regions = (
      MockQueueClient as unknown as { mock: { calls: [{ region?: string }][] } }
    ).mock.calls.map((call) => call[0].region);
    expect(new Set(regions)).toEqual(new Set(['sfo1', 'fra1']));
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it('returns an empty result set without touching the transport', async () => {
    const queue = createQueue();
    assert(queue.queueBatch);
    await expect(queue.queueBatch('__wkf_workflow_test', [])).resolves.toEqual(
      []
    );
    expect(mockSendBatch).not.toHaveBeenCalled();
  });
});

/**
 * A batched message carries its producer context on its OWN headers. The SDK
 * injects into the multipart request's headers, which VQS does not store per
 * message, so world-vercel injects per entry; without it a consumer's
 * `vqs.process` span has no link back to the producer (vqs-server re-emits a
 * stored `traceparent` as `x-vercel-queue-traceparent` at delivery).
 */
describe('queueBatch trace propagation', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    otelTrace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    context.disable();
    propagation.disable();
    otelTrace.disable();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_trace';
  });

  afterEach(() => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_QUEUE_TRACE_PROPAGATION;
  });

  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      message: { runId: 'wrun_trace', stepId: `step-${i}` },
      opts: { idempotencyKey: `key-${i}` },
    }));

  /** Publishes inside an active span and returns the sent message headers. */
  async function publishInSpan(
    count: number
  ): Promise<
    { headers: Record<string, string> | undefined; spanId: string }[]
  > {
    // Each step message has its own per-step topic, so a fan-out is one
    // batch request per step; answer each with one result per message.
    mockSendBatch.mockImplementation(
      async (_topic: string, messages: unknown[]) =>
        messages.map((_, i) => ({
          status: 'sent' as const,
          messageId: `m${i}`,
        }))
    );
    const queue = createQueue();
    assert(queue.queueBatch);
    const span = provider.getTracer('test').startSpan('publish');
    const spanId = span.spanContext().spanId;
    await context.with(otelTrace.setSpan(context.active(), span), async () => {
      await queue.queueBatch?.('__wkf_workflow_test', entries(count));
    });
    span.end();
    const sent = mockSendBatch.mock.calls.flatMap(
      (call) => call[1] as { headers?: Record<string, string> }[]
    );
    return sent.map((m) => ({ headers: m.headers, spanId }));
  }

  it('puts the producer traceparent on EVERY message in the batch', async () => {
    const sent = await publishInSpan(64);

    expect(sent).toHaveLength(64);
    for (const { headers, spanId } of sent) {
      // Same span on every entry: one publish, one producer context.
      expect(headers?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-/);
      expect(headers?.traceparent).toContain(spanId);
    }
    // The payload-derived headers the single send also carries survive it.
    expect(sent[0].headers?.['x-vercel-workflow-run-id']).toBe('wrun_trace');
    expect(sent[0].headers?.['x-vercel-workflow-step-id']).toBe('step-0');
  });

  it('honors VERCEL_QUEUE_TRACE_PROPAGATION=off, like the SDK does', async () => {
    process.env.VERCEL_QUEUE_TRACE_PROPAGATION = 'off';
    const sent = await publishInSpan(2);

    expect(sent).toHaveLength(2);
    for (const { headers } of sent) {
      expect(headers?.traceparent).toBeUndefined();
      // The kill switch is trace-only; message routing headers stay.
      expect(headers?.['x-vercel-workflow-run-id']).toBe('wrun_trace');
    }
  });
});
