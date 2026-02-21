import { FatalError, WorkflowAPIError } from '@workflow/errors';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so these are available in mock factories
const {
  capturedHandlerRef,
  mockEventsCreate,
  mockQueue,
  mockRuntimeLogger,
  mockStepLogger,
  mockQueueMessage,
  mockStepFn,
} = vi.hoisted(() => {
  const mockStepFn = Object.assign(vi.fn().mockResolvedValue('step-result'), {
    maxRetries: 3,
  });
  return {
    capturedHandlerRef: {
      current: null as null | ((...args: unknown[]) => Promise<unknown>),
    },
    mockEventsCreate: vi.fn(),
    mockQueue: vi.fn().mockResolvedValue({ messageId: 'msg_test' }),
    mockRuntimeLogger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    mockStepLogger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    mockQueueMessage: vi.fn().mockResolvedValue(undefined),
    mockStepFn,
  };
});

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

// Mock @vercel/functions
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

// Mock the world module - createQueueHandler captures the handler
vi.mock('./world.js', () => ({
  getWorld: vi.fn(() => ({
    events: { create: mockEventsCreate },
    queue: mockQueue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  })),
  getWorldHandlers: vi.fn(() => ({
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (...args: unknown[]) => Promise<unknown>
      ): ((req: Request) => Promise<Response>) => {
        capturedHandlerRef.current = handler;
        // Return a mock request handler
        return vi.fn() as unknown as (req: Request) => Promise<Response>;
      }
    ),
  })),
}));

// Mock telemetry
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name: string, _opts: unknown, fn?: unknown) => {
    // trace() can be called as trace(name, fn) or trace(name, opts, fn)
    const callback = typeof _opts === 'function' ? _opts : fn;
    return (callback as (span?: undefined) => unknown)(undefined);
  }),
  withTraceContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  getSpanKind: vi.fn().mockResolvedValue(undefined),
  linkToCurrentContext: vi.fn().mockResolvedValue([]),
  withWorkflowBaggage: vi.fn((_attrs: unknown, fn: () => unknown) => fn()),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  runtimeLogger: mockRuntimeLogger,
  stepLogger: mockStepLogger,
}));

// Mock helpers
vi.mock('./helpers.js', async () => {
  const actual =
    await vi.importActual<typeof import('./helpers.js')>('./helpers.js');
  return {
    ...actual,
    queueMessage: (...args: unknown[]) => mockQueueMessage(...args),
    withHealthCheck: (handler: unknown) => handler,
    parseHealthCheckPayload: vi.fn().mockReturnValue(null),
    handleHealthCheckMessage: vi.fn(),
    withServerErrorRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

// Mock serialization
vi.mock('../serialization.js', () => ({
  hydrateStepArguments: vi.fn().mockResolvedValue({
    args: [],
    thisVal: null,
    closureVars: undefined,
  }),
  dehydrateStepReturnValue: vi
    .fn()
    .mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

// Mock context storage
vi.mock('../step/context-storage.js', () => ({
  contextStorage: {
    run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  },
}));

// Mock types
vi.mock('../types.js', () => ({
  normalizeUnknownError: vi.fn().mockImplementation(async (err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : 'Error',
    stack: err instanceof Error ? err.stack : undefined,
  })),
  getErrorName: vi.fn().mockReturnValue('Error'),
  getErrorStack: vi.fn().mockReturnValue(''),
}));

// Mock private module
vi.mock('../private.js', () => ({
  getStepFunction: vi.fn().mockReturnValue(mockStepFn),
}));

// Mock get-port
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

// Import the module AFTER all mocks are set up - this triggers createQueueHandler
// which populates capturedHandlerRef
import './step-handler.js';
import { getStepFunction } from '../private.js';
import {
  normalizeUnknownError,
  getErrorName,
  getErrorStack,
} from '../types.js';
import { getWorld } from './world.js';

function capturedHandler(
  message: unknown,
  metadata: { queueName: string; messageId: string; attempt: number }
) {
  if (!capturedHandlerRef.current) {
    throw new Error(
      'capturedHandler not set - step-handler module did not initialize'
    );
  }
  return capturedHandlerRef.current(message, metadata);
}

function createMetadata(stepName: string) {
  return {
    queueName: `__wkf_step_${stepName}`,
    messageId: 'msg_test123',
    attempt: 1,
  };
}

function createMessage(overrides: Record<string, unknown> = {}) {
  return {
    workflowName: 'test-workflow',
    workflowRunId: 'wrun_test123',
    workflowStartedAt: Date.now(),
    stepId: 'step_abc',
    traceCarrier: undefined,
    requestedAt: new Date(),
    ...overrides,
  };
}

describe('step-handler 409 handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set mocks after clearAllMocks
    vi.mocked(getStepFunction).mockReturnValue(mockStepFn);
    vi.mocked(normalizeUnknownError).mockImplementation(
      async (err: unknown) => ({
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'Error',
        stack: err instanceof Error ? err.stack : undefined,
      })
    );
    vi.mocked(getErrorName).mockReturnValue('Error');
    vi.mocked(getErrorStack).mockReturnValue('');
    mockStepFn.mockReset().mockResolvedValue('step-result');
    mockStepFn.maxRetries = 3;
    mockQueueMessage.mockResolvedValue(undefined);
    // Re-set getWorld mock since clearAllMocks resets it
    vi.mocked(getWorld).mockReturnValue({
      events: { create: mockEventsCreate },
      queue: mockQueue,
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as any);
    // Reset mockEventsCreate fully - mockImplementation persists through clearAllMocks
    mockEventsCreate.mockReset().mockResolvedValue({
      step: {
        stepId: 'step_abc',
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
        input: [],
      },
      event: {},
    });
    mockStepFn.mockResolvedValue('step-result');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('step_completed 409', () => {
    it('should warn and return when step_completed gets a 409', async () => {
      // step_started succeeds, step function succeeds, step_completed returns 409
      let callCount = 0;
      mockEventsCreate.mockImplementation(
        (_runId: string, event: { eventType: string }) => {
          if (event.eventType === 'step_started') {
            return Promise.resolve({
              step: {
                stepId: 'step_abc',
                status: 'running',
                attempt: 1,
                startedAt: new Date(),
                input: [],
              },
              event: {},
            });
          }
          if (event.eventType === 'step_completed') {
            callCount++;
            return Promise.reject(
              new WorkflowAPIError(
                'Cannot complete step because it is already completed',
                { status: 409 }
              )
            );
          }
          return Promise.resolve({ event: {} });
        }
      );

      const result = await capturedHandler(
        createMessage(),
        createMetadata('myStep')
      );

      // Should not throw, should return undefined (early return)
      expect(result).toBeUndefined();
      // Should have logged a warning, not an error
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        'Tried completing step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
      // Should NOT have queued a workflow continuation
      expect(mockQueueMessage).not.toHaveBeenCalled();
    });
  });

  describe('step_failed 409 (max retries exhausted path)', () => {
    it('should warn and return when step_failed gets a 409 after max retries', async () => {
      // step_started succeeds with attempt > maxRetries+1, step function throws, step_failed returns 409
      mockStepFn.mockRejectedValue(new Error('step error'));
      mockStepFn.maxRetries = 2;
      mockEventsCreate.mockImplementation(
        (_runId: string, event: { eventType: string }) => {
          if (event.eventType === 'step_started') {
            return Promise.resolve({
              step: {
                stepId: 'step_abc',
                status: 'running',
                attempt: 3, // >= maxRetries + 1 (2 + 1 = 3)
                startedAt: new Date(),
                input: [],
                error: { stack: 'Error: step error' },
              },
              event: {},
            });
          }
          if (event.eventType === 'step_failed') {
            return Promise.reject(
              new WorkflowAPIError(
                'Cannot fail step because it is already completed',
                { status: 409 }
              )
            );
          }
          return Promise.resolve({ event: {} });
        }
      );

      const result = await capturedHandler(
        createMessage(),
        createMetadata('myStep')
      );

      expect(result).toBeUndefined();
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        'Tried failing step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
    });
  });

  describe('step_failed 409 (pre-execution max retries guard)', () => {
    it('should warn and return when step_failed gets a 409 on pre-execution guard', async () => {
      // step_started returns attempt > maxRetries+1 (pre-execution guard triggers)
      mockStepFn.maxRetries = 2;
      mockEventsCreate.mockImplementation(
        (_runId: string, event: { eventType: string }) => {
          if (event.eventType === 'step_started') {
            return Promise.resolve({
              step: {
                stepId: 'step_abc',
                status: 'running',
                attempt: 4, // > maxRetries + 1 (2 + 1 = 3), triggers pre-execution guard
                startedAt: new Date(),
                input: [],
                error: { stack: 'Error: previous' },
              },
              event: {},
            });
          }
          if (event.eventType === 'step_failed') {
            return Promise.reject(
              new WorkflowAPIError(
                'Cannot fail step because it is already completed',
                { status: 409 }
              )
            );
          }
          return Promise.resolve({ event: {} });
        }
      );

      const result = await capturedHandler(
        createMessage(),
        createMetadata('myStep')
      );

      expect(result).toBeUndefined();
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        'Tried failing step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
      // Step function should NOT have been called (pre-execution guard)
      expect(mockStepFn).not.toHaveBeenCalled();
    });
  });

  describe('step_retrying 409', () => {
    it('should warn and return when step_retrying gets a 409', async () => {
      // step_started succeeds with attempt=1, step throws a transient error,
      // step_retrying returns 409
      mockStepFn.maxRetries = 3;
      mockStepFn.mockRejectedValue(new Error('transient error'));
      mockEventsCreate.mockImplementation(
        (_runId: string, event: { eventType: string }) => {
          if (event.eventType === 'step_started') {
            return Promise.resolve({
              step: {
                stepId: 'step_abc',
                status: 'running',
                attempt: 1,
                startedAt: new Date(),
                input: [],
              },
              event: {},
            });
          }
          if (event.eventType === 'step_retrying') {
            return Promise.reject(
              new WorkflowAPIError(
                'Cannot retry step because it is already completed',
                { status: 409 }
              )
            );
          }
          return Promise.resolve({ event: {} });
        }
      );

      const result = await capturedHandler(
        createMessage(),
        createMetadata('myStep')
      );

      expect(result).toBeUndefined();
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        'Tried retrying step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
    });

    it('should re-throw non-409 errors from step_retrying', async () => {
      mockStepFn.maxRetries = 3;
      mockStepFn.mockRejectedValue(new Error('transient error'));
      mockEventsCreate.mockImplementation(
        (_runId: string, event: { eventType: string }) => {
          if (event.eventType === 'step_started') {
            return Promise.resolve({
              step: {
                stepId: 'step_abc',
                status: 'running',
                attempt: 1,
                startedAt: new Date(),
                input: [],
              },
              event: {},
            });
          }
          if (event.eventType === 'step_retrying') {
            return Promise.reject(
              new WorkflowAPIError('Internal Server Error', { status: 500 })
            );
          }
          return Promise.resolve({ event: {} });
        }
      );

      await expect(
        capturedHandler(createMessage(), createMetadata('myStep'))
      ).rejects.toThrow('Internal Server Error');
    });
  });
});
