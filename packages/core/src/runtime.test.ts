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

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

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
});
