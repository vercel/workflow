import { RUN_ERROR_CODES, WorkflowWorldError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPLAY_DIVERGENCE_MAX_RETRIES } from './runtime/constants.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';

// Capture every promise handed to `waitUntil` so tests can assert that
// progress-critical sends are never registered on a detached, unconsumed
// promise (which would reject → unhandled rejection → process exit 128, and
// frame the send as droppable-after-ack background work).
const waitUntilPromises: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    // Attach a no-op rejection handler immediately so a rejecting promise can
    // never surface as a real unhandled rejection in the test process before
    // `anyWaitUntilPromiseRejected()` inspects it. The original promise is kept
    // for later `allSettled` inspection.
    p.catch(() => {});
    waitUntilPromises.push(p);
  }),
}));

/**
 * Resolves true if any promise handed to `waitUntil` rejects. Reports whether
 * any registered promise rejected (each already carries a no-op handler from
 * the mock, so inspecting them here cannot itself leave a rejection unhandled).
 */
async function anyWaitUntilPromiseRejected(): Promise<boolean> {
  const results = await Promise.allSettled(waitUntilPromises);
  return results.some((r) => r.status === 'rejected');
}

async function runWorkflowHandlerWithEvents(
  workflowCode: string,
  workflowRun: WorkflowRun,
  events: Event[],
  options: {
    attempt?: number;
    createdEvents?: unknown[];
    queuedMessages?: unknown[];
    replayDivergence?: { eventId: string; count: number };
  } = {}
) {
  const createdEvents = options.createdEvents ?? [];
  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    createdEvents.push(data);

    if (data.eventType === 'run_started') {
      return {
        run: workflowRun,
        events,
      };
    }

    return {
      event: {
        eventId: `event-${createdEvents.length}`,
        runId: workflowRun.runId,
        createdAt: new Date(),
        ...data,
      },
    };
  });

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (message: unknown, metadata: unknown) => Promise<unknown>
      ) => {
        return async () => {
          await handler(
            {
              runId: workflowRun.runId,
              requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              replayDivergence: options.replayDivergence,
            },
            {
              requestId: 'req_test',
              attempt: options.attempt ?? 1,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        };
      }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({
        data: events,
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: {
      get: vi.fn(async () => workflowRun),
    },
    queue: vi.fn(async (_queueName: string, message: unknown) => {
      options.queuedMessages?.push(message);
      return { messageId: null };
    }),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const handler = workflowEntrypoint(workflowCode);
  await handler(new Request('https://example.test'));

  return createdEvents;
}

describe('workflowEntrypoint replay guards', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const getWorkflowTransformCode = (workflowName: string) =>
    `;globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName});`;

  it('records run_failed when run_started response schema validation fails', async () => {
    const createdEvents: unknown[] = [];
    const schemaError = new WorkflowWorldError(
      'Schema validation failed for POST /v3/runs/wrun_schema_validation/events:\n' +
        '  run.output: Invalid input: expected nonoptional, received undefined\n' +
        '  run.error: Invalid input: expected nonoptional, received undefined\n' +
        '  run.completedAt: Invalid input: expected nonoptional, received undefined',
      { code: 'SCHEMA_VALIDATION' }
    );
    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        throw schemaError;
      }

      createdEvents.push(data);
      return {
        event: {
          eventId: `event-${createdEvents.length}`,
          runId: 'wrun_schema_validation',
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            await handler(
              {
                runId: 'wrun_schema_validation',
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              },
              {
                requestId: 'req_test',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_test',
              }
            );
            return new Response(null, { status: 204 });
          };
        }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [],
          hasMore: false,
          cursor: 'cursor_test',
        })),
      },
      runs: {
        get: vi.fn(),
      },
      queue: vi.fn(),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(
      `async function workflow() {
        return 'done';
      }${getWorkflowTransformCode('workflow')}`
    );

    const response = await handler(new Request('https://example.test'));

    expect(response.status).toBe(204);
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
        }),
      })
    );
  });

  it('records run_failed when event listing response schema validation fails', async () => {
    const createdEvents: unknown[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_events_schema_validation',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_events_schema_validation',
        undefined,
        []
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    const schemaError = new WorkflowWorldError(
      'Schema validation failed for GET /v3/runs/wrun_events_schema_validation/events:\n' +
        '  data.0.eventData: Invalid input',
      { code: 'SCHEMA_VALIDATION' }
    );

    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType !== 'run_started') {
        createdEvents.push(data);
      }

      return data.eventType === 'run_started'
        ? { run: workflowRun }
        : {
            event: {
              eventId: `event-${createdEvents.length}`,
              runId: workflowRun.runId,
              createdAt: new Date(),
              ...data,
            },
          };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            await handler(
              {
                runId: workflowRun.runId,
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              },
              {
                requestId: 'req_test',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_test',
              }
            );
            return new Response(null, { status: 204 });
          };
        }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => {
          throw schemaError;
        }),
      },
      runs: {
        get: vi.fn(async () => workflowRun),
      },
      queue: vi.fn(),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(
      `async function workflow() {
        return 'done';
      }${getWorkflowTransformCode('workflow')}`
    );

    const response = await handler(new Request('https://example.test'));

    expect(response.status).toBe(204);
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
        }),
      })
    );
  });

  it('records run_failed when run_started response parsing fails', async () => {
    const createdEvents: unknown[] = [];
    const parseError = new WorkflowWorldError(
      'Failed to parse response body for POST /v3/runs/wrun_parse/events (Content-Type: application/cbor):\n\nError: unexpected end of file',
      { code: 'PARSE_ERROR' }
    );
    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        throw parseError;
      }

      createdEvents.push(data);
      return {
        event: {
          eventId: `event-${createdEvents.length}`,
          runId: 'wrun_parse',
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            await handler(
              {
                runId: 'wrun_parse',
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              },
              {
                requestId: 'req_test',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_test',
              }
            );
            return new Response(null, { status: 204 });
          };
        }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [],
          hasMore: false,
          cursor: 'cursor_test',
        })),
      },
      runs: {
        get: vi.fn(),
      },
      queue: vi.fn(),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(
      `async function workflow() {
        return 'done';
      }${getWorkflowTransformCode('workflow')}`
    );

    const response = await handler(new Request('https://example.test'));

    expect(response.status).toBe(204);
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
        }),
      })
    );
  });

  it('does not treat a terminal event from another run as this run outcome', async () => {
    const workflowRun: WorkflowRun = {
      runId: 'wrun_foreign_failed_event',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_foreign_failed_event',
        undefined,
        []
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    const events: Event[] = [
      {
        eventId: 'event-foreign-failed',
        runId: 'wrun_other',
        eventType: 'run_failed',
        eventData: {
          error: { message: 'another run failed' },
        },
        createdAt: new Date('2024-01-01T00:00:01.000Z'),
      },
    ];

    const createdEvents = await runWorkflowHandlerWithEvents(
      `async function workflow() {
        return 'done';
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events
    );

    expect(createdEvents).toContainEqual(
      expect.objectContaining({ eventType: 'run_completed' })
    );
  });

  it('redrives an initial replay divergence and fails after the recovery budget', async () => {
    const ops: Promise<any>[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_runtime_wait_guard',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_runtime_wait_guard',
        undefined,
        ops
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    const events: Event[] = [
      {
        eventId: 'event-0',
        runId: workflowRun.runId,
        eventType: 'wait_created',
        correlationId: 'wait_01HK153X00GYR8SV1JHHTGN5HE',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:05.000Z'),
        },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        eventId: 'event-1',
        runId: workflowRun.runId,
        eventType: 'wait_completed',
        correlationId: 'wait_01HK153X00GYR8SV1JHHTGN5HE',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:06.000Z'),
        },
        createdAt: new Date('2024-01-01T00:00:05.000Z'),
      },
    ];

    const initialAttemptEvents: unknown[] = [];
    const queuedMessages: unknown[] = [];
    await runWorkflowHandlerWithEvents(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      async function workflow() {
        await sleep('5s');
        return 'done';
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events,
      {
        createdEvents: initialAttemptEvents,
        queuedMessages,
      }
    );

    expect(initialAttemptEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
    expect(queuedMessages).toContainEqual(
      expect.objectContaining({
        replayDivergence: {
          eventId: 'event-0',
          count: 1,
        },
      })
    );

    const terminalAttemptEvents = await runWorkflowHandlerWithEvents(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      async function workflow() {
        await sleep('5s');
        return 'done';
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events,
      {
        replayDivergence: {
          eventId: 'different-event',
          count: REPLAY_DIVERGENCE_MAX_RETRIES,
        },
      }
    );

    expect(terminalAttemptEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: RUN_ERROR_CODES.CORRUPTED_EVENT_LOG,
        }),
      })
    );
  });

  it('redrives an initial replay divergence for a mismatched recorded hook', async () => {
    const ops: Promise<any>[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_runtime_hook_guard',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_runtime_hook_guard',
        undefined,
        ops
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    const events: Event[] = [
      {
        eventId: 'event-0',
        runId: workflowRun.runId,
        eventType: 'hook_received',
        correlationId: 'hook_01HK153X00GYR8SV1JHHTGN5HE',
        eventData: {
          token: 'wrong-token',
          payload: await dehydrateStepReturnValue(
            { message: 'hello' },
            'wrun_runtime_hook_guard',
            undefined,
            ops
          ),
        },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ];

    const createdEvents: unknown[] = [];
    const queuedMessages: unknown[] = [];
    await runWorkflowHandlerWithEvents(
      `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook({ token: 'expected-token' });
        const payload = await hook;
        return payload.message;
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events,
      { createdEvents, queuedMessages }
    );

    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
    expect(queuedMessages).toContainEqual(
      expect.objectContaining({
        replayDivergence: { eventId: 'event-0', count: 1 },
      })
    );
  });

  it('propagates transient step_created failures to the queue handler without an unhandled rejection', async () => {
    const createdEvents: unknown[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_step_created_parse',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_step_created_parse',
        undefined,
        []
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    // Simulates a transient network failure on POST /runs/{id}/events
    // (e.g. the connection terminated mid-response-body).
    const parseError = new WorkflowWorldError(
      'Failed to parse response body for POST /v3/runs/wrun_step_created_parse/events (Content-Type: application/cbor):\n\nTypeError: terminated',
      { code: 'PARSE_ERROR' }
    );
    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        return { run: workflowRun, events: [] };
      }
      if (data.eventType === 'step_created') {
        throw parseError;
      }
      createdEvents.push(data);
      return {
        event: {
          eventId: `event-${createdEvents.length}`,
          runId: workflowRun.runId,
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            await handler(
              {
                runId: workflowRun.runId,
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              },
              {
                requestId: 'req_test',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_test',
              }
            );
            return new Response(null, { status: 204 });
          };
        }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [],
          hasMore: false,
          cursor: 'cursor_test',
        })),
      },
      runs: {
        get: vi.fn(async () => workflowRun),
      },
      queue: vi.fn(async () => ({ messageId: null })),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
      async function workflow() {
        return await add(1, 2);
      }${getWorkflowTransformCode('workflow')}`
    );

    // The error must propagate to the queue handler (rejecting the
    // invocation) so the queue re-drives the message...
    await expect(handler(new Request('https://example.test'))).rejects.toThrow(
      'Failed to parse response body'
    );

    // ...the run must not be marked as failed (it will be retried)...
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );

    // ...and no promise handed to waitUntil may reject: nothing consumes
    // waitUntil rejections, so one would crash the process as an
    // unhandledRejection (this was the regression).
    const { waitUntil } = await import('@vercel/functions');
    await Promise.all(
      vi.mocked(waitUntil).mock.calls.map(([promise]) => promise)
    );
  });
});

describe('workflowEntrypoint step-dispatch ack ordering', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    waitUntilPromises.length = 0;
  });

  const getWorkflowTransformCode = (workflowName: string) =>
    `;globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName});`;

  // A workflow that suspends on a step AND a sleep. The pending wait makes the
  // V2 handler queue the step (instead of running it inline), exercising the
  // progress-critical step-dispatch queue() send that must complete before the
  // orchestrator message is acked.
  const stepWithSleepWorkflow = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      const [a] = await Promise.all([add(1, 2), sleep('1h')]);
      return a;
    }${getWorkflowTransformCode('workflow')}`;

  async function makeRunningRun(runId: string): Promise<WorkflowRun> {
    return {
      runId,
      workflowName: 'workflow',
      status: 'running',
      // The workflow takes no args, but the input must be a real dehydrated
      // payload so VM replay reconstructs the (empty) arguments instead of
      // throwing during hydration.
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
  }

  /**
   * Builds a mock world and drives the workflow handler. `queueImpl` lets a
   * test control the timing/outcome of the step-dispatch send. The returned
   * `order` array records a `'ack'` sentinel pushed the instant the handler
   * promise resolves, so tests can assert the dispatch send settled strictly
   * before the ack.
   */
  async function driveHandler(opts: {
    runId: string;
    queueImpl: (
      queueName: string,
      message: any
    ) => Promise<{ messageId: null }>;
  }) {
    const workflowRun = await makeRunningRun(opts.runId);
    const order: string[] = [];

    // Start from a clean slate so the rejection check only observes promises
    // this handler invocation registers — robust against test reordering or
    // `.only`, not just the afterEach reset between this suite's tests.
    waitUntilPromises.length = 0;

    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        return { run: workflowRun, events: [] as Event[] };
      }
      if (data.eventType === 'step_created') {
        order.push('step_created');
      }
      return {
        event: {
          eventId: `event-${order.length}`,
          runId: workflowRun.runId,
          createdAt: new Date(),
          ...data,
        },
      };
    });

    const queue = vi.fn(async (queueName: string, message: any) => {
      // Only the step-dispatch send carries a stepId; ignore other sends.
      if (message && typeof message === 'object' && 'stepId' in message) {
        order.push('queue_dispatch_start');
        const result = await opts.queueImpl(queueName, message);
        order.push('queue_dispatch_done');
        return result;
      }
      return { messageId: null };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            await handler(
              {
                runId: workflowRun.runId,
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              },
              {
                requestId: 'req_test',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_test',
              }
            );
            return new Response(null, { status: 204 });
          };
        }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [] as Event[],
          hasMore: false,
          cursor: 'cursor_test',
        })),
      },
      runs: {
        get: vi.fn(async () => workflowRun),
      },
      queue,
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(stepWithSleepWorkflow);
    // Push the ack sentinel the moment the handler resolves — i.e. right
    // before @vercel/queue would delete (ack) the orchestrator message.
    const handlerPromise = handler(new Request('https://example.test')).then(
      (res) => {
        order.push('ack');
        return res;
      }
    );

    return { handlerPromise, order, queue };
  }

  it('completes the step-dispatch send before the orchestrator message is acked', async () => {
    const { handlerPromise, order, queue } = await driveHandler({
      runId: 'wrun_ack_ordering_happy',
      queueImpl: async () => ({ messageId: null }),
    });

    const res = (await handlerPromise) as Response;
    expect(res.status).toBe(204);

    // The dispatch send must have happened, and its completion must strictly
    // precede the ack.
    expect(order).toContain('queue_dispatch_done');
    expect(order).toContain('ack');
    expect(order.indexOf('queue_dispatch_done')).toBeLessThan(
      order.indexOf('ack')
    );
    // step_created must precede the dispatch send (you can't dispatch a step
    // that isn't durably created).
    expect(order.indexOf('step_created')).toBeLessThan(
      order.indexOf('queue_dispatch_start')
    );
    expect(queue).toHaveBeenCalled();
  });

  it('does not ack while the step-dispatch send is still in flight', async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    let resolved = false;
    const { handlerPromise, order } = await driveHandler({
      runId: 'wrun_ack_ordering_hang',
      queueImpl: async () => {
        await sendGate;
        return { messageId: null };
      },
    });
    void handlerPromise.then(() => {
      resolved = true;
    });

    // Wait until the dispatch send has started (the handler has replayed,
    // created step_created, and entered the blocked queue() send), then assert
    // the handler has NOT resolved while the send is still in flight.
    await vi.waitFor(() => {
      expect(order).toContain('queue_dispatch_start');
    });
    // Flush microtasks so any (incorrect) early resolution would be observable.
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toContain('queue_dispatch_start');
    expect(order).not.toContain('queue_dispatch_done');
    expect(order).not.toContain('ack');
    expect(resolved).toBe(false);

    // Release the send so the handler can finish and we don't leak a pending
    // promise / open handle.
    releaseSend();
    await handlerPromise;
    expect(order.indexOf('queue_dispatch_done')).toBeLessThan(
      order.indexOf('ack')
    );
  });

  it('rejects the handler (no ack) when the step-dispatch send fails', async () => {
    const sendError = new Error('VQS send failed');
    const { handlerPromise, order } = await driveHandler({
      runId: 'wrun_ack_ordering_fail',
      queueImpl: async () => {
        throw sendError;
      },
    });

    await expect(handlerPromise).rejects.toThrow('VQS send failed');
    // A failed dispatch send must prevent the ack sentinel from being recorded
    // — the handler rejected, so @vercel/queue will NOT delete the message and
    // VQS redelivers within the lease.
    expect(order).not.toContain('ack');
    expect(order).toContain('step_created');

    // The dispatch send failure must surface ONLY through the rejected handler
    // promise (queue re-drive), never through an unconsumed `waitUntil`
    // promise (which would become an unhandled rejection / process exit 128).
    expect(await anyWaitUntilPromiseRejected()).toBe(false);
  });
});
