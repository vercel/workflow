import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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
    mockRuntimeLogger: (() => {
      const logger = {
        warn: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        forRun: vi.fn(),
        child: vi.fn(),
      };
      logger.forRun.mockReturnValue(logger);
      logger.child.mockReturnValue(logger);
      return logger;
    })(),
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
  getWorld: vi.fn(async () => ({
    events: { create: mockEventsCreate },
    queue: mockQueue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  })),
  getWorldHandlers: vi.fn(async () => ({
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
  cancelAbortReaders: vi.fn(),
  dehydrateStepError: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
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

import { getStepFunction } from '../private.js';
import {
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
} from '../types.js';
import { MAX_QUEUE_DELIVERIES } from './constants.js';
// Import the module AFTER all mocks are set up
// Since getWorldHandlers is now async, we need to call stepEntrypoint
// to trigger createQueueHandler and populate capturedHandlerRef
import { stepEntrypoint } from './step-handler.js';
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
  // Trigger the lazy handler initialization by calling stepEntrypoint once.
  // This invokes getWorldHandlers() which calls createQueueHandler and captures the handler.
  beforeAll(async () => {
    await stepEntrypoint(new Request('http://localhost'));
  });

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
    vi.mocked(getWorld).mockResolvedValue({
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
              new EntityConflictError(
                'Cannot complete step because it is already completed'
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
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        'Tried completing step, but step has already finished.',
        expect.objectContaining({
          errorName: 'EntityConflictError',
          errorMessage: expect.stringContaining('already completed'),
        })
      );
      // Workflow/step context is attached via the scoped logger (forRun),
      // not repeated in every log call.
      expect(mockRuntimeLogger.forRun).toHaveBeenCalledWith(
        'wrun_test123',
        expect.any(String),
        expect.objectContaining({ stepId: 'step_abc' })
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
          errorName: 'EntityConflictError',
          errorMessage: expect.stringContaining('already completed'),
        })
      );
      expect(mockRuntimeLogger.forRun).toHaveBeenCalledWith(
        'wrun_test123',
        expect.any(String),
        expect.objectContaining({ stepId: 'step_abc' })
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
          errorName: 'EntityConflictError',
          errorMessage: expect.stringContaining('already completed'),
        })
      );
      expect(mockRuntimeLogger.forRun).toHaveBeenCalledWith(
        'wrun_test123',
        expect.any(String),
        expect.objectContaining({ stepId: 'step_abc' })
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
          errorName: 'EntityConflictError',
          errorMessage: expect.stringContaining('already completed'),
        })
      );
      expect(mockRuntimeLogger.forRun).toHaveBeenCalledWith(
        'wrun_test123',
        expect.any(String),
        expect.objectContaining({ stepId: 'step_abc' })
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
    mockQueueMessage.mockResolvedValue(undefined);
    vi.mocked(getWorld).mockResolvedValue({
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
        eventData: expect.objectContaining({
          stepName: 'myStep',
          error: expect.any(Uint8Array),
        }),
      }),
      expect.anything()
    );
    expect(mockQueueMessage).toHaveBeenCalled();
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('exceeded max deliveries'),
      expect.objectContaining({ attempt: MAX_QUEUE_DELIVERIES + 1 })
    );
    expect(mockRuntimeLogger.forRun).toHaveBeenCalledWith(
      'wrun_test123',
      expect.any(String),
      expect.objectContaining({ stepId: 'step_abc' })
    );
  });

  it('should consume message silently when step_failed fails with EntityConflictError', async () => {
    mockEventsCreate.mockRejectedValue(
      new EntityConflictError('Step already completed')
    );

    const result = await capturedHandler(createMessage(), {
      ...createMetadata('myStep'),
      attempt: MAX_QUEUE_DELIVERIES + 1,
    });

    expect(result).toBeUndefined();
    expect(mockStepFn).not.toHaveBeenCalled();
  });

  it('should not trigger max deliveries check when under limit', async () => {
    const result = await capturedHandler(createMessage(), {
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
    mockQueueMessage.mockResolvedValue(undefined);
    vi.mocked(getWorld).mockResolvedValue({
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
        eventData: expect.objectContaining({
          stepName: 'missingStep',
        }),
      }),
      expect.anything()
    );
    // The error payload is now SerializedData (Uint8Array). The wire-format
    // message content is tested via the serialization test suite.
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_failed',
        correlationId: 'step_abc',
        eventData: expect.objectContaining({
          stepName: 'missingStep',
          error: expect.any(Uint8Array),
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
    // The error payload is now SerializedData (Uint8Array) — its contents
    // are tested via the serialization test suite. Here we just verify
    // that step_failed was written with a binary error field.
    expect(mockEventsCreate).toHaveBeenCalledWith(
      'wrun_test123',
      expect.objectContaining({
        eventType: 'step_failed',
        eventData: expect.objectContaining({
          stepName: 'badStep',
          error: expect.any(Uint8Array),
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
        errorName: 'EntityConflictError',
        errorMessage: expect.stringContaining('Step already completed'),
      })
    );
    expect(mockRuntimeLogger.forRun).toHaveBeenCalledWith(
      'wrun_test123',
      expect.any(String),
      expect.objectContaining({ stepName: 'missingStep' })
    );
    // Should NOT re-queue the workflow since step was already resolved
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });
});

/**
 * Regression gate for the most user-visible behavior change in this PR:
 * fatal user errors (`FatalError`, `ContextViolationError`,
 * `SerializationError`) should produce exactly one `step_failed` event
 * — no retries — while a non-fatal user `Error` should retry up to
 * `maxRetries`. Asserting on the live retry-loop wiring catches the
 * silent-regression case where someone removes `fatal = true` later
 * and the unit-level FatalError.is() tests stay green.
 */
describe('step-handler fatal vs retryable behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStepFunction).mockReturnValue(mockStepFn);
    vi.mocked(normalizeUnknownError).mockImplementation(
      async (err: unknown) => ({
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'UnknownError',
        stack: err instanceof Error ? err.stack : undefined,
      })
    );
    vi.mocked(getErrorName).mockImplementation((err: unknown) =>
      err instanceof Error ? err.name : 'UnknownError'
    );
    vi.mocked(getErrorStack).mockImplementation((err: unknown) =>
      err instanceof Error ? (err.stack ?? '') : ''
    );
    mockQueueMessage.mockResolvedValue(undefined);
    vi.mocked(getWorld).mockResolvedValue({
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

  it('emits exactly one step_failed and does not re-queue when the step throws an error with fatal=true', async () => {
    // Simulates a `ContextViolationError` / `SerializationError` —
    // both opt into the no-retry path via a `fatal: true` own property
    // that `FatalError.is()` recognizes.
    class FatalUserError extends Error {
      readonly fatal = true;
      name = 'FatalUserError';
    }
    mockStepFn.mockReset().mockRejectedValue(new FatalUserError('boom'));
    mockStepFn.maxRetries = 3;

    await capturedHandler(createMessage(), createMetadata('myStep'));

    const stepFailedCalls = mockEventsCreate.mock.calls.filter(
      ([, event]) => event.eventType === 'step_failed'
    );
    expect(stepFailedCalls).toHaveLength(1);
    // The retry path uses `step_retrying`; the fatal path skips it.
    const stepRetryingCalls = mockEventsCreate.mock.calls.filter(
      ([, event]) => event.eventType === 'step_retrying'
    );
    expect(stepRetryingCalls).toHaveLength(0);
  });

  it('schedules a retry (and does not fail the step) on the first attempt of a non-fatal Error', async () => {
    mockStepFn
      .mockReset()
      .mockRejectedValue(new Error('Transient failure, will succeed later'));
    mockStepFn.maxRetries = 3;

    await capturedHandler(
      createMessage(),
      createMetadata('myStep', { attempt: 1 })
    );

    // Non-fatal first attempt: re-queue via step_retrying, no terminal failure.
    const stepRetryingCalls = mockEventsCreate.mock.calls.filter(
      ([, event]) => event.eventType === 'step_retrying'
    );
    expect(stepRetryingCalls).toHaveLength(1);
    const stepFailedCalls = mockEventsCreate.mock.calls.filter(
      ([, event]) => event.eventType === 'step_failed'
    );
    expect(stepFailedCalls).toHaveLength(0);
  });

  it('emits step_failed once the non-fatal retry budget is exhausted', async () => {
    mockStepFn.mockReset().mockRejectedValue(new Error('Transient failure'));
    mockStepFn.maxRetries = 3;
    // Final attempt: total attempts = maxRetries + 1.
    mockEventsCreate.mockReset().mockResolvedValueOnce({
      step: {
        stepId: 'step_abc',
        status: 'running',
        attempt: 4,
        startedAt: new Date(),
        input: [],
      },
      event: {},
    });
    // Subsequent emissions (e.g. step_failed) get a generic ack.
    mockEventsCreate.mockResolvedValue({ event: {} });

    await capturedHandler(
      createMessage(),
      createMetadata('myStep', { attempt: 4 })
    );

    const stepFailedCalls = mockEventsCreate.mock.calls.filter(
      ([, event]) => event.eventType === 'step_failed'
    );
    expect(stepFailedCalls).toHaveLength(1);
  });
});
