import {
  EntityConflictError,
  FatalError,
  RunExpiredError,
  ThrottleError,
  WorkflowWorldError,
} from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted so these are available in mock factories
const {
  capturedHandlerRef,
  mockEventsCreate,
  mockQueue,
  mockRuntimeLogger,
  mockStepLogger,
  mockQueueMessage,
  mockStepFn,
  mockStepSpan,
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
    mockStepSpan: {
      setAttributes: vi.fn(),
      addEvent: vi.fn(),
    },
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
    return (callback as (span?: typeof mockStepSpan) => unknown)(
      _name.startsWith('STEP ') ? mockStepSpan : undefined
    );
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
  formatSerializationError: vi.fn(
    (context: string) => `Failed to serialize ${context}.`
  ),
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

// Import the module AFTER all mocks are set up - this triggers createQueueHandler
// which populates capturedHandlerRef
import './step-handler.js';
import { getStepFunction } from '../private.js';
import { hydrateStepArguments } from '../serialization.js';
import {
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
} from '../types.js';
import { MAX_QUEUE_DELIVERIES } from './constants.js';
import {
  resetPortCacheForTesting,
  setPortResolverForTesting,
} from './get-port-lazy.js';
import {
  UNSERIALIZABLE_STEP_INPUT_MARKER,
  unserializableStepInputPlaceholder,
} from './unserializable-step.js';
import { getWorld } from './world.js';

const mockPortResolver = vi.fn(async () => 3000);

beforeEach(() => {
  mockPortResolver.mockReset().mockResolvedValue(3000);
  setPortResolverForTesting(mockPortResolver);
});

afterEach(() => {
  resetPortCacheForTesting();
});

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

function createMetadata(
  stepName: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    queueName: `__wkf_step_${stepName}`,
    messageId: 'msg_test123',
    attempt: 1,
    ...overrides,
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
    mockQueueMessage.mockReset().mockResolvedValue(undefined);
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

  it('reuses cached port discovery across step invocations', async () => {
    await capturedHandler(createMessage(), createMetadata('myStep'));
    await capturedHandler(createMessage(), createMetadata('myStep'));

    expect(mockPortResolver).toHaveBeenCalledOnce();
  });

  describe('step_completed 409', () => {
    beforeEach(() => {
      let completed = false;
      mockEventsCreate.mockImplementation(
        (_runId: string, event: { eventType: string }) => {
          if (event.eventType === 'step_started') {
            if (completed) {
              return Promise.reject(
                new EntityConflictError('Step already completed')
              );
            }
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
            // The write committed, but its response was lost. The transport
            // retries the write and surfaces the already-completed conflict.
            completed = true;
            return Promise.reject(
              new EntityConflictError(
                'Cannot complete step because it is already completed'
              )
            );
          }
          return Promise.resolve({ event: {} });
        }
      );
    });

    it('should queue the workflow continuation when step_completed gets a 409', async () => {
      const result = await capturedHandler(
        createMessage(),
        createMetadata('myStep')
      );

      expect(result).toBeUndefined();
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        'Tried completing step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
      expect(mockStepFn).toHaveBeenCalledOnce();
      expect(mockStepSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          'step.skipped': true,
          'step.skip_reason': 'completed',
        })
      );
      expect(mockStepSpan.addEvent).toHaveBeenCalledWith('step.skipped', {
        'skip.reason': 'terminal_state',
        'step.name': 'myStep',
        'step.id': 'step_abc',
      });
      expect(mockQueueMessage).toHaveBeenCalledExactlyOnceWith(
        getWorld(),
        '__wkf_workflow_test-workflow',
        {
          runId: 'wrun_test123',
          traceCarrier: {},
          requestedAt: expect.any(Date),
        }
      );
    });

    it('should retry a failed continuation send without executing the completed step again', async () => {
      const sendError = new Error('queue send failed');
      mockQueueMessage.mockRejectedValueOnce(sendError);
      const message = createMessage();

      await expect(
        capturedHandler(message, createMetadata('myStep'))
      ).rejects.toThrow(sendError);

      // The queue redelivers the same message. step_started now returns 409,
      // so the handler retries only the workflow continuation.
      await expect(
        capturedHandler(message, createMetadata('myStep', { attempt: 2 }))
      ).resolves.toBeUndefined();

      expect(mockStepFn).toHaveBeenCalledOnce();
      expect(
        mockEventsCreate.mock.calls.filter(
          ([, event]) => event.eventType === 'step_completed'
        )
      ).toHaveLength(1);
      expect(mockQueueMessage).toHaveBeenCalledTimes(2);
      expect(mockQueueMessage).toHaveBeenLastCalledWith(
        getWorld(),
        '__wkf_workflow_test-workflow',
        {
          runId: 'wrun_test123',
          traceCarrier: {},
          requestedAt: expect.any(Date),
        }
      );
    });
  });

  const failureCases = [
    { name: 'missing function', bodyCalls: 0 },
    { name: 'pre-execution retry limit', bodyCalls: 0 },
    { name: 'missing startedAt', bodyCalls: 0 },
    { name: 'FatalError', bodyCalls: 1 },
    { name: 'post-execution retry limit', bodyCalls: 1 },
  ] as const;

  function mockFailureResponse(
    name: (typeof failureCases)[number]['name'],
    writeError: Error = new EntityConflictError('Step already failed')
  ) {
    if (name === 'missing function') {
      vi.mocked(getStepFunction).mockReturnValue(undefined);
    } else if (name === 'FatalError') {
      mockStepFn.mockRejectedValue(new FatalError('fatal step error'));
    } else if (name === 'post-execution retry limit') {
      mockStepFn.maxRetries = 0;
      mockStepFn.mockRejectedValue(new Error('step error'));
    }
    const step = {
      stepId: 'step_abc',
      status: 'running',
      attempt: name === 'pre-execution retry limit' ? 5 : 1,
      startedAt: name === 'missing startedAt' ? undefined : new Date(),
      input: [],
    };
    let failed = false;
    mockEventsCreate.mockImplementation(
      (_runId: string, event: { eventType: string }) => {
        if (event.eventType === 'step_started') {
          if (failed) {
            return Promise.reject(
              new EntityConflictError('Step already failed')
            );
          }
          return Promise.resolve({
            step,
            event: {},
          });
        }
        if (event.eventType === 'step_failed') {
          // A committed terminal write with a lost response surfaces as 409.
          failed = EntityConflictError.is(writeError);
          return Promise.reject(writeError);
        }
        return Promise.resolve({ event: {} });
      }
    );
  }

  describe.each(failureCases)('step_failed lost response ($name)', ({
    name,
    bodyCalls,
  }) => {
    beforeEach(() => {
      mockFailureResponse(name);
    });

    it('should wake the workflow after the failure write conflicts', async () => {
      await expect(
        capturedHandler(createMessage(), createMetadata('myStep'))
      ).resolves.toBeUndefined();

      expect(mockStepFn).toHaveBeenCalledTimes(bodyCalls);
      expect(
        mockEventsCreate.mock.calls.map(([, event]) => event.eventType)
      ).toEqual(['step_started', 'step_failed']);
      expect(mockQueueMessage).toHaveBeenCalledExactlyOnceWith(
        getWorld(),
        '__wkf_workflow_test-workflow',
        {
          runId: 'wrun_test123',
          traceCarrier: {},
          requestedAt: expect.any(Date),
        }
      );
    });

    it('should redeliver a failed wake without rerunning the failed step', async () => {
      const sendError = new Error('queue send failed');
      mockQueueMessage.mockRejectedValueOnce(sendError);
      const message = createMessage();

      await expect(
        capturedHandler(message, createMetadata('myStep'))
      ).rejects.toThrow(sendError);
      await expect(
        capturedHandler(message, createMetadata('myStep', { attempt: 2 }))
      ).resolves.toBeUndefined();

      expect(mockStepFn).toHaveBeenCalledTimes(bodyCalls);
      expect(
        mockEventsCreate.mock.calls.map(([, event]) => event.eventType)
      ).toEqual(['step_started', 'step_failed', 'step_started']);
      expect(mockQueueMessage).toHaveBeenCalledTimes(2);
      expect(mockQueueMessage).toHaveBeenLastCalledWith(
        getWorld(),
        '__wkf_workflow_test-workflow',
        {
          runId: 'wrun_test123',
          traceCarrier: {},
          requestedAt: expect.any(Date),
        }
      );
    });

    it('should propagate other persistence errors without acknowledging or waking the workflow', async () => {
      const writeError = new WorkflowWorldError('Persistence unavailable');
      mockFailureResponse(name, writeError);

      await expect(
        capturedHandler(createMessage(), createMetadata('myStep'))
      ).rejects.toThrow(writeError);
      expect(mockQueueMessage).not.toHaveBeenCalled();
    });
  });

  describe('step_failed 409 (max retries exhausted path)', () => {
    it('should log and re-queue when step_failed gets a 409 after max retries', async () => {
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
              new EntityConflictError(
                'Cannot fail step because it is already completed'
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
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        'Tried failing step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
      expect(mockQueueMessage).toHaveBeenCalledOnce();
    });
  });

  describe('step_failed 409 (pre-execution max retries guard)', () => {
    it('should log and re-queue when step_failed gets a 409 on pre-execution guard', async () => {
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
              new EntityConflictError(
                'Cannot fail step because it is already completed'
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
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        'Tried failing step, but step has already finished.',
        expect.objectContaining({
          workflowRunId: 'wrun_test123',
          stepId: 'step_abc',
        })
      );
      // Step function should NOT have been called (pre-execution guard)
      expect(mockStepFn).not.toHaveBeenCalled();
      expect(mockQueueMessage).toHaveBeenCalledOnce();
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
              new EntityConflictError(
                'Cannot retry step because it is already completed'
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
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
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
              new WorkflowWorldError('Internal Server Error', { status: 500 })
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

  describe('requestId propagation', () => {
    it('should pass requestId to events.create for step_started', async () => {
      await capturedHandler(
        createMessage(),
        createMetadata('myStep', { requestId: 'iad1::req-abc' })
      );

      const startedCall = mockEventsCreate.mock.calls.find(
        ([, event]: [string, { eventType: string }]) =>
          event.eventType === 'step_started'
      );
      expect(startedCall).toBeDefined();
      expect(startedCall![2]).toEqual(
        expect.objectContaining({ requestId: 'iad1::req-abc' })
      );
    });

    it('should pass requestId to events.create for step_completed', async () => {
      await capturedHandler(
        createMessage(),
        createMetadata('myStep', { requestId: 'iad1::req-abc' })
      );

      const completedCall = mockEventsCreate.mock.calls.find(
        ([, event]: [string, { eventType: string }]) =>
          event.eventType === 'step_completed'
      );
      expect(completedCall).toBeDefined();
      expect(completedCall![2]).toEqual(
        expect.objectContaining({ requestId: 'iad1::req-abc' })
      );
    });

    it('should pass undefined requestId when not provided in metadata', async () => {
      await capturedHandler(createMessage(), createMetadata('myStep'));

      const startedCall = mockEventsCreate.mock.calls.find(
        ([, event]: [string, { eventType: string }]) =>
          event.eventType === 'step_started'
      );
      expect(startedCall).toBeDefined();
      expect(startedCall![2]).toEqual(
        expect.objectContaining({ requestId: undefined })
      );
    });
  });
});

describe('step-handler max deliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStepFunction).mockReturnValue(mockStepFn);
    mockStepFn.mockReset().mockResolvedValue('step-result');
    mockStepFn.maxRetries = 3;
    mockQueueMessage.mockReset().mockResolvedValue(undefined);
    vi.mocked(getWorld).mockReturnValue({
      events: { create: mockEventsCreate },
      queue: mockQueue,
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as any);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should post step_failed and re-queue workflow when delivery count exceeds max', async () => {
    const result = await capturedHandler(createMessage(), {
      ...createMetadata('myStep'),
      attempt: MAX_QUEUE_DELIVERIES + 1,
    });

    expect(result).toBeUndefined();
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_failed',
        correlationId: 'step_abc',
      }),
      expect.anything()
    );
    expect(mockQueueMessage).toHaveBeenCalled();
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('exceeded max deliveries'),
      expect.objectContaining({ workflowRunId: 'wrun_test123' })
    );
  });

  it('should re-queue the workflow when step_failed fails with EntityConflictError', async () => {
    // The step may have been failed by this message's own earlier delivery,
    // whose workflow re-queue then failed: wake the workflow regardless.
    mockEventsCreate.mockRejectedValue(
      new EntityConflictError('Step already completed')
    );

    const result = await capturedHandler(createMessage(), {
      ...createMetadata('myStep'),
      attempt: MAX_QUEUE_DELIVERIES + 1,
    });

    expect(result).toBeUndefined();
    expect(mockStepFn).not.toHaveBeenCalled();
    expect(mockQueueMessage).toHaveBeenCalledTimes(1);
  });

  it('should consume message silently when the run has already finished', async () => {
    mockEventsCreate.mockRejectedValue(new RunExpiredError('Run completed'));

    const result = await capturedHandler(createMessage(), {
      ...createMetadata('myStep'),
      attempt: MAX_QUEUE_DELIVERIES + 1,
    });

    expect(result).toBeUndefined();
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      'ThrottleError (429)',
      new ThrottleError('rate limited', { retryAfter: 5 }),
    ],
    [
      'WorkflowWorldError (5xx)',
      new WorkflowWorldError('server error', { status: 503 }),
    ],
  ])('should throw (not strand the run) when step_failed hits a transient %s', async (_label, transientError) => {
    // Regression: acking on any step_failed failure left the step `running`
    // and the run with no message left to drive it.
    mockEventsCreate.mockRejectedValue(transientError);

    await expect(
      capturedHandler(createMessage(), {
        ...createMetadata('myStep'),
        attempt: MAX_QUEUE_DELIVERIES + 1,
      })
    ).rejects.toBe(transientError);
    expect(mockStepFn).not.toHaveBeenCalled();
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it('should throw when re-queueing the workflow fails', async () => {
    const sendError = new Error('queue send failed');
    mockQueueMessage.mockRejectedValue(sendError);

    await expect(
      capturedHandler(createMessage(), {
        ...createMetadata('myStep'),
        attempt: MAX_QUEUE_DELIVERIES + 1,
      })
    ).rejects.toBe(sendError);
  });

  it('should consume the message on a definitive step_failed rejection', async () => {
    mockEventsCreate.mockRejectedValue(
      new WorkflowWorldError('bad request', { status: 400 })
    );

    const result = await capturedHandler(createMessage(), {
      ...createMetadata('myStep'),
      attempt: MAX_QUEUE_DELIVERIES + 1,
    });

    expect(result).toBeUndefined();
    expect(mockQueueMessage).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark step as failed'),
      expect.anything()
    );
  });

  it('should not trigger max deliveries check when under limit', async () => {
    await capturedHandler(createMessage(), {
      ...createMetadata('myStep'),
      attempt: MAX_QUEUE_DELIVERIES,
    });

    // Should proceed normally (step function executes)
    expect(mockStepFn).toHaveBeenCalled();
  });
});

describe('step-handler step not found', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStepFn.mockReset().mockResolvedValue('step-result');
    mockStepFn.maxRetries = 3;
    mockQueueMessage.mockReset().mockResolvedValue(undefined);
    vi.mocked(getWorld).mockReturnValue({
      events: { create: mockEventsCreate },
      queue: mockQueue,
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as any);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fail the step (not the run) when step function is not found', async () => {
    vi.mocked(getStepFunction).mockReturnValue(undefined);

    const result = await capturedHandler(
      createMessage(),
      createMetadata('missingStep')
    );

    // Should not throw - returns normally so the queue message is consumed
    expect(result).toBeUndefined();

    // Should have created step_started then step_failed events
    expect(mockEventsCreate).toHaveBeenCalledTimes(2);
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_started',
      }),
      expect.anything()
    );
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_failed',
        correlationId: 'step_abc',
        eventData: expect.objectContaining({
          error: expect.stringContaining(
            'Step "missingStep" is not registered'
          ),
        }),
      }),
      expect.anything()
    );

    // Should re-queue the workflow so it can handle the failed step
    expect(mockQueueMessage).toHaveBeenCalled();

    // Step function should NOT have been called
    expect(mockStepFn).not.toHaveBeenCalled();
  });

  it('should fail the step when step function is not a function', async () => {
    vi.mocked(getStepFunction).mockReturnValue(
      'not-a-function' as unknown as ReturnType<typeof getStepFunction>
    );

    const result = await capturedHandler(
      createMessage(),
      createMetadata('badStep')
    );

    expect(result).toBeUndefined();
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_failed',
        eventData: expect.objectContaining({
          error: expect.stringContaining('Step "badStep" is not registered'),
        }),
      }),
      expect.anything()
    );
    expect(mockQueueMessage).toHaveBeenCalled();
  });

  it('should handle EntityConflictError when failing step for missing function', async () => {
    vi.mocked(getStepFunction).mockReturnValue(undefined);
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
        if (event.eventType === 'step_failed') {
          callCount++;
          return Promise.reject(
            new EntityConflictError('Step already completed')
          );
        }
        return Promise.resolve({ event: {} });
      }
    );

    const result = await capturedHandler(
      createMessage(),
      createMetadata('missingStep')
    );

    // Should return without throwing - step was already finished
    expect(result).toBeUndefined();
    expect(callCount).toBe(1);
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      'Tried failing step for missing function, but step has already finished.',
      expect.objectContaining({
        workflowRunId: 'wrun_test123',
        stepId: 'step_abc',
      })
    );
    // The terminal event may be this invocation's own committed write.
    expect(mockQueueMessage).toHaveBeenCalledOnce();
  });
});

describe('step-handler unserializable-argument placeholder recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStepFunction).mockReturnValue(mockStepFn);
    vi.mocked(normalizeUnknownError).mockImplementation(
      async (err: unknown) => ({
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'Error',
        stack: err instanceof Error ? err.stack : undefined,
      })
    );
    vi.mocked(getErrorName).mockReturnValue('FatalError');
    vi.mocked(getErrorStack).mockReturnValue('');
    mockStepFn.mockReset().mockResolvedValue('step-result');
    mockStepFn.maxRetries = 3;
    mockQueueMessage.mockReset().mockResolvedValue(undefined);
    vi.mocked(getWorld).mockReturnValue({
      events: { create: mockEventsCreate },
      queue: mockQueue,
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as any);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(hydrateStepArguments).mockResolvedValue({
      args: [],
      thisVal: null,
      closureVars: undefined,
    } as any);
  });

  it('fails a placeholder-input step without running the step body', async () => {
    // A crash between finalization's two durable writes leaves a lone
    // step_created carrying the placeholder; crash recovery dispatches it
    // here. The body must not run — the intended failure completes instead.
    vi.mocked(hydrateStepArguments).mockResolvedValue(
      unserializableStepInputPlaceholder() as any
    );

    const result = await capturedHandler(
      createMessage(),
      createMetadata('acceptAnyValue')
    );

    expect(result).toBeUndefined();
    expect(mockStepFn).not.toHaveBeenCalled();
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_failed',
        eventData: expect.objectContaining({
          error: expect.stringContaining('Failed to serialize step arguments'),
        }),
      }),
      expect.anything()
    );
    // Fatal: no step_retrying, so no queue attempts are burned.
    expect(mockEventsCreate).not.toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({ eventType: 'step_retrying' }),
      expect.anything()
    );
  });

  it('does not trip on a genuine argument equal to the display marker', async () => {
    // The structural flag — not the human-readable marker string — is what
    // identifies the placeholder, so a step legitimately called with the
    // marker text still runs.
    vi.mocked(hydrateStepArguments).mockResolvedValue({
      args: [UNSERIALIZABLE_STEP_INPUT_MARKER],
      thisVal: null,
      closureVars: undefined,
    } as any);

    await capturedHandler(createMessage(), createMetadata('acceptAnyValue'));

    expect(mockStepFn).toHaveBeenCalledWith(UNSERIALIZABLE_STEP_INPUT_MARKER);
  });
});
