import {
  type RUN_ERROR_CODES,
  WorkflowNotRegisteredError,
} from '@workflow/errors';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const {
  capturedHandlerRef,
  mockEventsCreate,
  mockRunWorkflow,
  mockRuntimeLogger,
} = vi.hoisted(() => {
  return {
    capturedHandlerRef: {
      current: null as null | ((...args: unknown[]) => Promise<unknown>),
    },
    mockEventsCreate: vi.fn(),
    mockRunWorkflow: vi.fn(),
    mockRuntimeLogger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('./world.js', () => ({
  getWorld: vi.fn(async () => ({
    events: { create: mockEventsCreate },
  })),
  getWorldHandlers: vi.fn(async () => ({
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (...args: unknown[]) => Promise<unknown>
      ): ((req: Request) => Promise<Response>) => {
        capturedHandlerRef.current = handler;
        return vi.fn() as unknown as (req: Request) => Promise<Response>;
      }
    ),
  })),
}));

vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name: string, _opts: unknown, fn?: unknown) => {
    const callback = typeof _opts === 'function' ? _opts : fn;
    return (callback as (span?: undefined) => unknown)(undefined);
  }),
  withTraceContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  linkToCurrentContext: vi.fn().mockResolvedValue([]),
  withWorkflowBaggage: vi.fn((_attrs: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../logger.js', () => ({
  runtimeLogger: mockRuntimeLogger,
}));

vi.mock('./helpers.js', async () => {
  const actual =
    await vi.importActual<typeof import('./helpers.js')>('./helpers.js');
  return {
    ...actual,
    withHealthCheck: (handler: unknown) => handler,
    parseHealthCheckPayload: vi.fn().mockReturnValue(null),
    handleHealthCheckMessage: vi.fn(),
    getAllWorkflowRunEvents: vi.fn().mockResolvedValue([]),
    getQueueOverhead: vi.fn().mockReturnValue({}),
  };
});

vi.mock('../types.js', () => ({
  normalizeUnknownError: vi.fn().mockImplementation(async (err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : 'Error',
    stack: err instanceof Error ? err.stack : undefined,
  })),
  getErrorName: vi.fn().mockReturnValue('Error'),
  getErrorStack: vi.fn().mockReturnValue(''),
}));

vi.mock('../workflow.js', () => ({
  runWorkflow: (...args: unknown[]) => mockRunWorkflow(...args),
}));

import { workflowEntrypoint } from '../runtime.js';

function capturedHandler(
  message: unknown,
  metadata: {
    queueName: string;
    messageId: string;
    attempt: number;
    requestId?: string;
  }
) {
  if (!capturedHandlerRef.current) {
    throw new Error('capturedHandler not set');
  }
  return capturedHandlerRef.current(message, metadata);
}

function createRun(runId: string, workflowName: string) {
  const startedAt = new Date();
  return {
    runId,
    workflowName,
    status: 'running',
    createdAt: startedAt,
    startedAt,
    completedAt: null,
    input: [],
    deploymentId: 'dpl_local@test',
    specVersion: 3,
    executionContext: {},
  };
}

function createRunStartedResult(runId: string, workflowName: string) {
  return {
    run: createRun(runId, workflowName),
    events: [
      {
        eventId: 'evnt_created',
        eventType: 'run_created',
        specVersion: 3,
        runId,
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_started',
        eventType: 'run_started',
        specVersion: 3,
        runId,
        createdAt: new Date(),
      },
    ],
  };
}

describe('workflowEntrypoint lazy-discovery retry for unregistered workflow', () => {
  beforeAll(async () => {
    // Initialize handler capture by creating the route handler once.
    await workflowEntrypoint('globalThis.__private_workflows = new Map();')(
      new Request('http://localhost', { method: 'POST' })
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;
  });

  it('re-enqueues on WorkflowNotRegisteredError in lazy discovery mode', async () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '1';

    const runId = 'wrun_lazy_retry_1';
    const workflowName = 'workflow//./app/lib/agent-stop//agentStoppedWorkflow';

    mockEventsCreate.mockImplementation(
      (_runId: string, event: { eventType: string }) => {
        if (event.eventType === 'run_started') {
          return Promise.resolve(createRunStartedResult(runId, workflowName));
        }
        return Promise.resolve({ event: {} });
      }
    );
    mockRunWorkflow.mockRejectedValue(
      new WorkflowNotRegisteredError(workflowName)
    );

    const result = await capturedHandler(
      {
        runId,
        runInput: {
          input: [],
          deploymentId: 'dpl_local@test',
          workflowName,
          specVersion: 3,
          executionContext: {},
        },
      },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: 'msg_retry_1',
        attempt: 1,
        requestId: 'req_retry_1',
      }
    );

    expect(result).toEqual({ timeoutSeconds: 1 });
    expect(mockEventsCreate).not.toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ eventType: 'run_failed' }),
      expect.anything()
    );
  });

  it('fails run after lazy-discovery retry window is exhausted', async () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '1';

    const runId = 'wrun_lazy_retry_2';
    const workflowName = 'workflow//./app/lib/agent-stop//agentStoppedWorkflow';

    mockEventsCreate.mockImplementation(
      (_runId: string, event: { eventType: string; eventData?: unknown }) => {
        if (event.eventType === 'run_started') {
          return Promise.resolve(createRunStartedResult(runId, workflowName));
        }
        if (event.eventType === 'run_failed') {
          return Promise.resolve({ event });
        }
        return Promise.resolve({ event: {} });
      }
    );
    mockRunWorkflow.mockRejectedValue(
      new WorkflowNotRegisteredError(workflowName)
    );

    const result = await capturedHandler(
      {
        runId,
        runInput: {
          input: [],
          deploymentId: 'dpl_local@test',
          workflowName,
          specVersion: 3,
          executionContext: {},
        },
      },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: 'msg_retry_2',
        attempt: 9,
        requestId: 'req_retry_2',
      }
    );

    expect(result).toBeUndefined();
    expect(mockEventsCreate).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: 'RUNTIME_ERROR' satisfies RUN_ERROR_CODES,
        }),
      }),
      expect.objectContaining({ requestId: 'req_retry_2' })
    );
  });
});
