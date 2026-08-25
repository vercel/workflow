import {
  EntityConflictError,
  PreconditionFailedError,
  RUN_ERROR_CODES,
  ThrottleError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from './logger.js';
import { registerStepFunction } from './private.js';
import {
  DEPLOYMENT_MISMATCH_MAX_RETRIES,
  REPLAY_DIVERGENCE_MAX_RETRIES,
} from './runtime/constants.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateRunError,
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

/** One recorded `world.queue` call from the harness's queue mock. */
type QueueCall = {
  queueName: string;
  message: any;
  opts?: Record<string, unknown>;
};

async function runWorkflowHandlerWithEvents(
  workflowCode: string,
  workflowRun: WorkflowRun,
  events: Event[],
  options: {
    attempt?: number;
    createdEvents?: unknown[];
    createdEventParams?: unknown[];
    queueCalls?: QueueCall[];
    replayDivergence?: { eventId: string; count: number };
    /**
     * Make created events visible to subsequent events.list calls (appended
     * to `events`), like a real World. Needed for flows where the handler
     * makes in-process progress over its own writes (e.g. an attr_set
     * resolved by the next replay iteration). Off by default so tests that
     * pin the log's contents keep full control.
     */
    dynamicEventLog?: boolean;
    currentDeploymentId?: string;
    /** `deploymentMismatchRetryCount` on the incoming queue message. */
    deploymentMismatchRetryCount?: number;
    /** Set both to drive the background-step branch of the combined handler. */
    incomingStepId?: string;
    incomingStepName?: string;
    /** Lazy hook resume payload carried on the incoming queue message. */
    hookInput?: Record<string, unknown>;
    queueImpl?: () => Promise<{ messageId: null }>;
    isDeploymentUnavailableError?: (error: unknown) => boolean;
  } = {}
) {
  const createdEvents = options.createdEvents ?? [];
  const eventsCreate = vi.fn(
    async (_runId: string, data: any, params?: any) => {
      createdEvents.push(data);
      options.createdEventParams?.push(params);

      if (data.eventType === 'run_started') {
        return {
          run: workflowRun,
          events,
        };
      }

      const event = {
        eventId: slotToEventId(createdEvents.length),
        runId: workflowRun.runId,
        createdAt: new Date(),
        ...data,
      };
      if (options.dynamicEventLog) {
        events.push(event as Event);
      }
      return { event };
    }
  );

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    // Declares atomic, immutable deployments (as world-vercel does); worlds
    // that leave it unset (local/postgres) skip the deployment guard.
    capabilities: { deploymentAffinity: true },
    getDeploymentId: vi.fn(
      async () => options.currentDeploymentId ?? workflowRun.deploymentId
    ),
    isDeploymentUnavailableError: options.isDeploymentUnavailableError,
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
              deploymentMismatchRetryCount:
                options.deploymentMismatchRetryCount,
              stepId: options.incomingStepId,
              stepName: options.incomingStepName,
              hookInput: options.hookInput,
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
    queue: vi.fn(
      async (
        queueName: string,
        message: unknown,
        opts?: Record<string, unknown>
      ) => {
        options.queueCalls?.push({ queueName, message, opts });
        if (options.queueImpl) return options.queueImpl();
        return { messageId: null };
      }
    ),
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

  /** A run pinned to `dpl_origin`, for the deployment-affinity tests below. */
  const misroutedRun = async (): Promise<WorkflowRun> => ({
    runId: 'wrun_wrong_deployment',
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments(
      [],
      'wrun_wrong_deployment',
      undefined,
      []
    ),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'dpl_origin',
    specVersion: SPEC_VERSION_CURRENT,
  });

  const mustNotRun = `async function workflow() {
        throw new Error('workflow code must not execute');
      }${getWorkflowTransformCode('workflow')}`;

  it('re-routes a flow replay delivered to a different deployment', async () => {
    const workflowRun = await misroutedRun();
    const queueCalls: QueueCall[] = [];

    const createdEvents = await runWorkflowHandlerWithEvents(
      mustNotRun,
      workflowRun,
      [],
      { currentDeploymentId: 'dpl_current', queueCalls }
    );

    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].opts).toMatchObject({
      deploymentId: 'dpl_origin',
      specVersion: SPEC_VERSION_CURRENT,
      delaySeconds: 1,
    });
    expect(queueCalls[0].message).toMatchObject({
      runId: 'wrun_wrong_deployment',
      deploymentMismatchRetryCount: 1,
    });
    // `runInput` must not ride along — it would re-engage turbo on the next
    // delivery and wedge the run.
    expect(queueCalls[0].message).not.toHaveProperty('runInput');
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
  });

  it('leaves a misrouted delivery unacked when re-enqueue fails transiently', async () => {
    const workflowRun = await misroutedRun();
    const createdEvents: unknown[] = [];
    const sendError = new Error('transient VQS failure');

    await expect(
      runWorkflowHandlerWithEvents(mustNotRun, workflowRun, [], {
        currentDeploymentId: 'dpl_current',
        createdEvents,
        queueImpl: async () => {
          throw sendError;
        },
        isDeploymentUnavailableError: () => false,
      })
    ).rejects.toBe(sendError);
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
  });

  it('re-routes a queued step execution, preserving the pending step', async () => {
    const workflowRun = await misroutedRun();
    const queueCalls: QueueCall[] = [];

    const createdEvents = await runWorkflowHandlerWithEvents(
      mustNotRun,
      workflowRun,
      [],
      {
        currentDeploymentId: 'dpl_current',
        incomingStepId: 'step_1',
        incomingStepName: 'myStep',
        queueCalls,
      }
    );

    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].opts).toMatchObject({ deploymentId: 'dpl_origin' });
    expect(queueCalls[0].message).toMatchObject({
      runId: 'wrun_wrong_deployment',
      stepId: 'step_1',
      stepName: 'myStep',
      deploymentMismatchRetryCount: 1,
    });
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'step_started' })
    );
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
  });

  it('re-routes a misrouted lazy hook resume with its payload intact', async () => {
    // The lazy-resume producer parallelizes the `hook_received` write with this
    // queue publish, so `hookInput` may be the only copy of the payload. A
    // modern message carries `hookInput.deploymentId`, so the cheap pre-check
    // detects the mismatch BEFORE the fast path's hook_received write —
    // zero event writes before re-routing — and the re-routed message has to
    // carry the complete `hookInput` or the resume is lost when the
    // producer's direct write had not landed.
    const workflowRun = await misroutedRun();
    const queueCalls: QueueCall[] = [];
    const hookInput = {
      resumeId: '01JQZ0000000000000000000000',
      hookId: 'hook_1',
      token: 'tok_1',
      payload: { serialized: true },
      payloadDigest: 'sha256:abc',
      deploymentId: 'dpl_origin',
    };

    const createdEvents = await runWorkflowHandlerWithEvents(
      mustNotRun,
      workflowRun,
      [],
      { currentDeploymentId: 'dpl_current', hookInput, queueCalls }
    );

    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].opts).toMatchObject({ deploymentId: 'dpl_origin' });
    // The complete hookInput — payload included — survives re-routing.
    expect(queueCalls[0].message).toMatchObject({
      deploymentMismatchRetryCount: 1,
      hookInput,
    });
    // Zero event writes before re-routing: neither the fast path's
    // hook_received nor the generic setup's run_started ran.
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'hook_received' })
    );
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_started' })
    );
  });

  it('fails a misrouted run once the re-route budget is spent', async () => {
    const workflowRun = await misroutedRun();
    const queueCalls: QueueCall[] = [];

    const createdEvents = await runWorkflowHandlerWithEvents(
      mustNotRun,
      workflowRun,
      [],
      {
        currentDeploymentId: 'dpl_current',
        deploymentMismatchRetryCount: DEPLOYMENT_MISMATCH_MAX_RETRIES,
        queueCalls,
      }
    );

    expect(queueCalls).toHaveLength(0);
    const failedEvent = createdEvents.find(
      (event: any) => event.eventType === 'run_failed'
    ) as any;
    expect(failedEvent).toBeDefined();
    expect(failedEvent.eventData.errorCode).toBe(
      RUN_ERROR_CODES.DEPLOYMENT_MISMATCH
    );
    const error = await hydrateRunError(
      failedEvent.eventData.error,
      workflowRun.runId,
      undefined
    );
    // Wording is pinned by deployment-guard.test.ts; this checks the round trip.
    expect(error).toMatchObject({ name: 'WorkflowDeploymentMismatchError' });
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_completed' })
    );
  });

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
          eventId: slotToEventId(createdEvents.length),
          runId: 'wrun_schema_validation',
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => 'test-deployment'),
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
              eventId: slotToEventId(createdEvents.length),
              runId: workflowRun.runId,
              createdAt: new Date(),
              ...data,
            },
          };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => 'test-deployment'),
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

  it('redelivers (does NOT fail the run) when event listing hits a transient TRANSPORT error', async () => {
    const createdEvents: unknown[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_events_transport',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_events_transport',
        undefined,
        []
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    // The firewall in front of workflow-server returned 429→503 during an
    // attack; the RetryAgent exhausted its retries and surfaced
    // UND_ERR_REQ_RETRY, which world-vercel maps to a TRANSPORT error.
    const transportError = new WorkflowWorldError(
      'GET /v3/runs/wrun_events_transport/events transport failure after 1234ms (UND_ERR_REQ_RETRY)',
      { code: 'TRANSPORT' }
    );

    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType !== 'run_started') {
        createdEvents.push(data);
      }
      return data.eventType === 'run_started'
        ? { run: workflowRun }
        : {
            event: {
              eventId: slotToEventId(createdEvents.length),
              runId: workflowRun.runId,
              createdAt: new Date(),
              ...data,
            },
          };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            // The real createQueueHandler catches and applies a retry
            // directive; here we let the throw escape so the test can assert
            // the delivery rejects (which triggers redelivery in production).
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
          throw transportError;
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

    // The transient transport failure must bubble out of the handler so the
    // queue redelivers — not be swallowed into a run_failed event.
    await expect(handler(new Request('https://example.test'))).rejects.toBe(
      transportError
    );

    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
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
          eventId: slotToEventId(createdEvents.length),
          runId: 'wrun_parse',
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
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
        eventId: slotToEventId(1),
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
        eventId: slotToEventId(1),
        runId: workflowRun.runId,
        eventType: 'wait_created',
        correlationId: 'wait_01HK153X00VFKAJV9XFN9JXXRS',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:05.000Z'),
        },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        eventId: slotToEventId(2),
        runId: workflowRun.runId,
        eventType: 'wait_completed',
        correlationId: 'wait_01HK153X00VFKAJV9XFN9JXXRS',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:06.000Z'),
        },
        createdAt: new Date('2024-01-01T00:00:05.000Z'),
      },
    ];

    const initialAttemptEvents: unknown[] = [];
    const queueCalls: QueueCall[] = [];
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
        queueCalls,
      }
    );

    expect(initialAttemptEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
    expect(queueCalls.map((c) => c.message)).toContainEqual(
      expect.objectContaining({
        replayDivergence: {
          eventId: slotToEventId(1),
          count: 1,
        },
      })
    );

    const terminalAttemptEvents: unknown[] = [];
    const terminalAttemptParams: unknown[] = [];
    await runWorkflowHandlerWithEvents(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      async function workflow() {
        await sleep('5s');
        return 'done';
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events,
      {
        createdEvents: terminalAttemptEvents,
        createdEventParams: terminalAttemptParams,
        replayDivergence: {
          eventId: 'different-event',
          count: REPLAY_DIVERGENCE_MAX_RETRIES,
        },
      }
    );

    const failedIndex = terminalAttemptEvents.findIndex(
      (event) => (event as { eventType?: string }).eventType === 'run_failed'
    );
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(terminalAttemptEvents[failedIndex]).toEqual(
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: RUN_ERROR_CODES.CORRUPTED_EVENT_LOG,
        }),
      })
    );
    expect(terminalAttemptParams[failedIndex]).toEqual(
      expect.objectContaining({
        replayDivergenceCount: REPLAY_DIVERGENCE_MAX_RETRIES + 1,
      })
    );
  });

  it('reports a recovered divergence episode on the next natural event write', async () => {
    const workflowRun: WorkflowRun = {
      runId: 'wrun_runtime_replay_recovered',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_runtime_replay_recovered',
        undefined,
        []
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    const createdEvents: any[] = [];
    const createdEventParams: any[] = [];

    await runWorkflowHandlerWithEvents(
      `async function workflow() {
        return 'recovered';
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      [],
      {
        createdEvents,
        createdEventParams,
        replayDivergence: {
          eventId: 'event-diverged',
          count: 2,
        },
      }
    );

    const completedIndex = createdEvents.findIndex(
      (event) => event.eventType === 'run_completed'
    );
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(createdEventParams[completedIndex]).toEqual(
      expect.objectContaining({
        replayDivergenceCount: 2,
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

    // `hook_created` records a hook a replay decided to create, so its
    // position and identity are that replay's decision record: one the current
    // replay does not create is divergence on the spot. A `hook_received` here
    // would not be, since a delivery nobody claims is parked for a later
    // consumer (see 'suspends rather than failing on a hook delivery that
    // matches no hook' below).
    const events: Event[] = [
      {
        eventId: slotToEventId(1),
        runId: workflowRun.runId,
        eventType: 'hook_created',
        correlationId: 'hook_01HK153X00VFKAJV9XFN9JXXRS',
        eventData: {
          token: 'wrong-token',
          isWebhook: false,
        },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ];

    const createdEvents: unknown[] = [];
    const queueCalls: QueueCall[] = [];
    await runWorkflowHandlerWithEvents(
      `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook({ token: 'expected-token' });
        const payload = await hook;
        return payload.message;
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events,
      { createdEvents, queueCalls }
    );

    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
    expect(queueCalls.map((c) => c.message)).toContainEqual(
      expect.objectContaining({
        replayDivergence: { eventId: slotToEventId(1), count: 1 },
      })
    );
  });

  it('suspends rather than failing on a hook delivery that matches no hook', async () => {
    const ops: Promise<any>[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_runtime_hook_parked',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_runtime_hook_parked',
        undefined,
        ops
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    // A delivery for a hook this replay never registers a consumer for. A
    // writer that raced this replay can leave one in the log legitimately, so
    // it is held for a consumer a later replay may register instead of ending
    // the run.
    const events: Event[] = [
      {
        eventId: slotToEventId(1),
        runId: workflowRun.runId,
        eventType: 'hook_received',
        correlationId: 'hook_01HK153X00VFKAJV9XFN9JXXRS',
        eventData: {
          token: 'some-other-hook',
          payload: await dehydrateStepReturnValue(
            { message: 'hello' },
            'wrun_runtime_hook_parked',
            undefined,
            ops
          ),
        },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ];

    const createdEvents: unknown[] = [];
    const queueCalls: QueueCall[] = [];
    await runWorkflowHandlerWithEvents(
      `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook({ token: 'expected-token' });
        const payload = await hook;
        return payload.message;
      }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events,
      { createdEvents, queueCalls }
    );

    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'run_failed' })
    );
    expect(createdEvents).toContainEqual(
      expect.objectContaining({ eventType: 'hook_created' })
    );
    expect(
      queueCalls.filter((call) => 'replayDivergence' in (call.message ?? {}))
    ).toEqual([]);
  });

  it('replays attribute events before executing a step that loses the same race', async () => {
    const debug = vi
      .spyOn(runtimeLogger, 'debug')
      .mockImplementation(() => undefined);
    const ops: Promise<any>[] = [];
    const workflowRun: WorkflowRun = {
      runId: 'wrun_attribute_step_race',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_attribute_step_race',
        undefined,
        ops
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    const workflowCode = `
      const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
      const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
      const slowStep = useStep("slowStep");
      async function workflow() {
        await Promise.race([
          setAttributes([{ key: "winner", value: "attribute" }]),
          slowStep(),
        ]);
        return "attribute won";
      }${getWorkflowTransformCode('workflow')}`;

    const createdEvents: any[] = [];
    const queueCalls: QueueCall[] = [];
    await runWorkflowHandlerWithEvents(workflowCode, workflowRun, [], {
      createdEvents,
      queueCalls,
      dynamicEventLog: true,
    });

    expect(createdEvents).toContainEqual(
      expect.objectContaining({ eventType: 'attr_set' })
    );
    // The attr_set suspension skips step processing and resolves through an
    // in-process replay, where the durable attribute event wins the race —
    // so the run completes within this same delivery, with no queue
    // interaction.
    expect(createdEvents).toContainEqual(
      expect.objectContaining({ eventType: 'run_completed' })
    );
    expect(queueCalls).toEqual([]);
    // Under lazy inline start the step that loses the attribute race is NOT
    // eagerly created: its step_created is deferred for a lazy step_started
    // that never fires, because the attribute-resolving replay decides the
    // race before any step executes. So the losing step leaves no events at
    // all — strictly less event-log garbage than the eager model.
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'step_created' })
    );
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({ eventType: 'step_started' })
    );
    const executionModes = debug.mock.calls
      .filter(([message]) => message === 'Starting workflow execution')
      .map(([, context]) => context?.executionMode);
    expect(executionModes).toEqual(['replay', 'replay']);
    debug.mockRestore();
  });

  it('fails the run when the World rejects an attr_set event as invalid', async () => {
    const workflowRun: WorkflowRun = {
      runId: 'wrun_attr_validation',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_attr_validation',
        undefined,
        []
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    // The cumulative per-run attribute cap can only be checked by the World
    // against the run's existing attributes — the VM-side validation in
    // normalizeAttributeChanges cannot see them. The rejection is
    // deterministic: redelivering the message replays the same write into
    // the same 400, so the run must FAIL (run_failed) rather than reject
    // the delivery and wedge the run in queue redelivery.
    const capError = new WorkflowWorldError(
      'Run attribute count would exceed limit 64',
      { status: 400 }
    );
    const createdEvents: any[] = [];
    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        return { run: workflowRun, events: [] };
      }
      if (data.eventType === 'attr_set') {
        throw capError;
      }
      createdEvents.push(data);
      return {
        event: {
          eventId: slotToEventId(createdEvents.length),
          runId: workflowRun.runId,
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
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
      `const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
      async function workflow() {
        await setAttributes([{ key: "one_too_many", value: "v" }]);
        return "wrote";
      }${getWorkflowTransformCode('workflow')}`
    );

    // The handler must resolve (ack) — a deterministic validation failure
    // must not reject the delivery into a redelivery loop.
    await handler(new Request('https://example.test'));

    // The run is failed with the World's validation message so the user can
    // see why, instead of the run hanging in "running" forever.
    const runFailed = createdEvents.find((e) => e.eventType === 'run_failed') as
      | { eventData: { error: Uint8Array } }
      | undefined;
    expect(runFailed).toBeDefined();
    const serializedError = new TextDecoder().decode(
      runFailed?.eventData.error
    );
    expect(serializedError).toContain(
      'Run attribute count would exceed limit 64'
    );
  });

  it('propagates transient step-creation failures (lazy step_started) to the queue handler without an unhandled rejection', async () => {
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
    // (e.g. the connection terminated mid-response-body). Under lazy inline
    // start the step is created on the fly by its step_started, so the
    // transient failure surfaces there (the standalone step_created round-trip
    // no longer exists on this path).
    const parseError = new WorkflowWorldError(
      'Failed to parse response body for POST /v3/runs/wrun_step_created_parse/events (Content-Type: application/cbor):\n\nTypeError: terminated',
      { code: 'PARSE_ERROR' }
    );
    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        return { run: workflowRun, events: [] };
      }
      if (data.eventType === 'step_started') {
        throw parseError;
      }
      createdEvents.push(data);
      return {
        event: {
          eventId: slotToEventId(createdEvents.length),
          runId: workflowRun.runId,
          createdAt: new Date(),
          ...data,
        },
      };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
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
  // Pin to a single inline step so exactly one of the two parallel steps is
  // queued — these tests assert the dispatch→ack ordering for that QUEUED step,
  // which is independent of how many steps run inline. (With the default of
  // `getMaxInlineSteps()` both would run inline and nothing would be queued.)
  beforeEach(() => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
  });
  afterEach(() => {
    delete process.env.WORKFLOW_MAX_INLINE_STEPS;
    setWorld(undefined);
    vi.clearAllMocks();
    waitUntilPromises.length = 0;
  });

  const getWorkflowTransformCode = (workflowName: string) =>
    `;globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName});`;

  // A workflow that suspends on TWO parallel steps and a sleep. Under the
  // lazy-inline-start model exactly one pending step is run inline (its
  // step_created is deferred and folded into a lazy step_started); every other
  // pending step keeps its eager step_created and is QUEUED via the unified
  // dispatch. So the second step here is always queued, exercising the
  // progress-critical step-dispatch queue() send that must complete before the
  // orchestrator message is acked — independent of which step the runtime
  // happens to pick for inline execution.
  const stepWithSleepWorkflow = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
    const addB = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("addB");
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      const [a] = await Promise.all([add(1, 2), addB(3, 4), sleep('1h')]);
      return a;
    }${getWorkflowTransformCode('workflow')}`;

  // Register the two steps so the one chosen for inline execution actually
  // runs (and completes) instead of failing as unregistered; the other is
  // queued. Both are no-ops — these tests only assert dispatch/ack ordering.
  registerStepFunction('add', async () => undefined);
  registerStepFunction('addB', async () => undefined);

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

    // Stateful event log so replay converges instead of re-suspending forever:
    // the inline step's events and the queued step's eager step_created are
    // recorded here and returned by `list`, so a later loop iteration observes
    // the inline step as done and the queued step as already-created (and thus
    // not re-run/re-inlined).
    let eventSeq = 0;
    const durableEvents: Event[] = [];
    const recordEvent = (data: any): Event => {
      eventSeq += 1;
      const created = {
        eventId: slotToEventId(eventSeq),
        runId: workflowRun.runId,
        createdAt: new Date(),
        ...data,
      } as Event;
      durableEvents.push(created);
      return created;
    };

    const createdEventParams: any[] = [];
    const stepStartedParams: any[] = [];
    const eventsCreate = vi.fn(
      async (_runId: string, data: any, params?: any) => {
        createdEventParams.push(params);
        if (data.eventType === 'step_started') {
          stepStartedParams.push(params);
        }
        if (data.eventType === 'run_started') {
          return { run: workflowRun, events: [] as Event[] };
        }
        if (data.eventType === 'step_created') {
          // Eager step_created for the QUEUED step (the one not run inline).
          // It must be durably created before its dispatch send — the ordering
          // assertion below checks step_created precedes queue_dispatch_start.
          order.push('step_created');
          return { event: recordEvent(data) };
        }
        if (data.eventType === 'step_started') {
          // The inline step's lazy step_started creates the step on the fly:
          // record a synthetic step_created so replay observes it, then the
          // step_started, and return a running step so executeStep can run the
          // (registered, no-op) body to completion.
          const lazy = data.eventData as { stepName?: string; input?: unknown };
          if (lazy?.input !== undefined) {
            recordEvent({
              eventType: 'step_created',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: data.correlationId,
              eventData: { stepName: lazy.stepName, input: lazy.input },
            });
          }
          const created = recordEvent(data);
          return {
            event: created,
            step: {
              runId: workflowRun.runId,
              stepId: data.correlationId,
              stepName: lazy?.stepName,
              status: 'running' as const,
              attempt: 1,
              input: lazy?.input,
              startedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            ...(lazy?.input !== undefined ? { stepCreated: true } : {}),
          };
        }
        return { event: recordEvent(data) };
      }
    );

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
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
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
        // Return the accumulated event log so replay converges: a later loop
        // iteration sees the inline step completed and the queued step already
        // created (so neither is re-run), and the handler returns instead of
        // re-suspending forever.
        list: vi.fn(async () => ({
          data: [...durableEvents],
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

    return {
      handlerPromise,
      order,
      queue,
      createdEventParams,
      stepStartedParams,
    };
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
    // The full VM replay leading up to the send can take well over
    // vi.waitFor's default 1s timeout on slow CI runners (notably Windows).
    await vi.waitFor(
      () => {
        expect(order).toContain('queue_dispatch_start');
      },
      { timeout: 15_000 }
    );
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

  it('runs BOTH parallel steps inline (none queued) when the inline cap allows it', async () => {
    // Override the per-suite cap of 1: with a cap of 3 both `add` and `addB`
    // are deferred and run inline via lazy step_started, so neither is eagerly
    // created or dispatched to a background handler. Only the sleep's wait
    // continuation is queued (it carries no stepId).
    process.env.WORKFLOW_MAX_INLINE_STEPS = '3';

    const { handlerPromise, order, stepStartedParams } = await driveHandler({
      runId: 'wrun_multi_inline',
      queueImpl: async () => ({ messageId: null }),
    });

    const res = (await handlerPromise) as Response;
    expect(res.status).toBe(204);

    // No eager step_created and no step-dispatch send: both steps went inline.
    expect(order).not.toContain('step_created');
    expect(order).not.toContain('queue_dispatch_start');
    expect(stepStartedParams).toHaveLength(2);
    for (const params of stepStartedParams) {
      expect(params).toMatchObject({ requestId: 'req_test' });
    }
  });

  it('does not re-queue a throttled inline step as an input-less background step', async () => {
    // Regression: a `throttled` result means the lazy step_started lost on the
    // atomic create-claim, so the step was never created and has no input to
    // recover. Re-queuing it as a background step would send a bare
    // step_started that the world rejects with "Step not found", redelivering
    // until MAX_QUEUE_DELIVERIES fails the run. The runtime must instead defer
    // the orchestrator (return a timeout) so the step re-runs inline WITH its
    // input on replay — never enqueue a stepId message for the throttled step.
    process.env.WORKFLOW_MAX_INLINE_STEPS = '3';
    registerStepFunction('tA', async () => undefined);
    registerStepFunction('tB', async () => undefined);
    const wf = `const tA = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("tA");
      const tB = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("tB");
      async function workflow() {
        const r = await Promise.all([tA(), tB()]);
        return r;
      }${getWorkflowTransformCode('workflow')}`;

    const workflowRun = await makeRunningRun('wrun_throttle_inline');
    const durableEvents: Event[] = [];
    let seq = 0;
    const rec = (data: any): Event => {
      seq += 1;
      const e = {
        eventId: slotToEventId(seq),
        runId: workflowRun.runId,
        createdAt: new Date(),
        ...data,
      } as Event;
      durableEvents.push(e);
      return e;
    };
    // The SECOND lazy step_started to arrive is throttled (rejected on the
    // create-claim); the first completes normally. Keyed by arrival order so we
    // don't depend on which correlationId the runtime starts first.
    let startedSeen = 0;
    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started')
        return { run: workflowRun, events: [] as Event[] };
      if (data.eventType === 'step_started') {
        const d = data.eventData as { stepName?: string; input?: unknown };
        startedSeen += 1;
        if (startedSeen === 2) {
          throw new ThrottleError('rate limited', { retryAfter: 5 });
        }
        if (d?.input !== undefined)
          rec({
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: data.correlationId,
            eventData: { stepName: d.stepName, input: d.input },
          });
        return {
          event: rec(data),
          step: {
            runId: workflowRun.runId,
            stepId: data.correlationId,
            stepName: d?.stepName,
            status: 'running' as const,
            attempt: 1,
            input: d?.input,
            startedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          ...(d?.input !== undefined ? { stepCreated: true } : {}),
        };
      }
      return { event: rec(data) };
    });
    const stepIdMessages: unknown[] = [];
    const queue = vi.fn(async (_queueName: string, message: any) => {
      if (message && typeof message === 'object' && 'stepId' in message) {
        stepIdMessages.push(message.stepId);
      }
      return { messageId: null };
    });
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
      createQueueHandler: vi.fn(
        (_p: string, handler: (m: unknown, md: unknown) => Promise<unknown>) =>
          async () => {
            await handler(
              { runId: workflowRun.runId, requestedAt: new Date() },
              {
                requestId: 'req',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg',
              }
            );
            return new Response(null, { status: 204 });
          }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [...durableEvents],
          hasMore: false,
          cursor: 'c',
        })),
      },
      runs: { get: vi.fn(async () => workflowRun) },
      queue,
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const res = (await workflowEntrypoint(wf)(
      new Request('https://example.test')
    )) as Response;
    expect(res.status).toBe(204);
    // The throttled step is NOT re-queued as a background (stepId) message —
    // the orchestrator is deferred instead so it re-runs inline with input.
    expect(stepIdMessages).toHaveLength(0);
  });
});

describe('workflowEntrypoint resilient step consumption (stepInput re-ensure)', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const getWorkflowTransformCode = (workflowName: string) =>
    `;globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName});`;

  // The workflow body is never replayed by these tests: the seeded log keeps
  // an unrelated step pending, so the background-step path returns right
  // after executing the message's step.
  const resilientWorkflow = `const resilientAdd = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("resilientAdd");
    async function workflow() {
      return await resilientAdd(2, 3);
    }${getWorkflowTransformCode('workflow')}`;

  const stepBodySpy = vi.fn(async (a: number, b: number) => a + b);
  registerStepFunction('resilientAdd', stepBodySpy);

  /**
   * Drives the handler with a background-step message carrying `stepInput`.
   * The event log is seeded with a pending unrelated step so the handler
   * returns after the step executes (no full workflow replay to converge).
   */
  async function driveStepMessage(opts: {
    runId: string;
    attempt: number;
    /** Reject the step_created re-ensure with this error. */
    ensureError?: Error;
    omitStepInput?: boolean;
    /**
     * Simulate the delivery beating the producer's parallel step_created:
     * bare step_started rejects with this error until a step_created for the
     * step has been written (the in-band re-ensure path).
     */
    stepMissingError?: Error;
  }) {
    const stepId = 'step_resilient_1';
    const dehydratedInput = (await dehydrateStepArguments(
      { args: [2, 3], closureVars: [], thisVal: null },
      opts.runId,
      undefined
    )) as Uint8Array;

    const workflowRun: WorkflowRun = {
      runId: opts.runId,
      workflowName: 'workflow',
      status: 'running',
      specVersion: SPEC_VERSION_CURRENT,
      input: await dehydrateWorkflowArguments([], opts.runId, undefined, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    // Slot 1 is taken by the seeded event below, so recorded events start at 2.
    let eventSeq = 1;
    const durableEvents: Event[] = [
      // An unrelated pending step: keeps the run un-replayable so the handler
      // returns right after the background step completes.
      {
        eventId: slotToEventId(1),
        runId: opts.runId,
        createdAt: new Date(),
        eventType: 'step_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'step_other',
        eventData: { stepName: 'otherStep', input: dehydratedInput },
      } as unknown as Event,
    ];
    const recordEvent = (data: any): Event => {
      eventSeq += 1;
      const created = {
        eventId: slotToEventId(eventSeq),
        runId: opts.runId,
        createdAt: new Date(),
        ...data,
      } as Event;
      durableEvents.push(created);
      return created;
    };

    const createdEvents: any[] = [];
    const createdEventParams: any[] = [];
    let stepEntityExists = false;
    const eventsCreate = vi.fn(
      async (_runId: string, data: any, params?: any) => {
        createdEvents.push(data);
        createdEventParams.push(params);
        if (data.eventType === 'step_created') {
          if (opts.ensureError) throw opts.ensureError;
          stepEntityExists = true;
          return { event: recordEvent(data) };
        }
        if (data.eventType === 'step_started') {
          if (opts.stepMissingError && !stepEntityExists) {
            throw opts.stepMissingError;
          }
          return {
            event: recordEvent(data),
            step: {
              runId: opts.runId,
              stepId,
              stepName: 'resilientAdd',
              status: 'running' as const,
              attempt: 1,
              input: dehydratedInput,
              startedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
        return { event: recordEvent(data) };
      }
    );

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
                runId: opts.runId,
                stepId,
                stepName: 'resilientAdd',
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
                ...(opts.omitStepInput
                  ? {}
                  : { stepInput: { input: dehydratedInput } }),
              },
              {
                requestId: 'req_test',
                attempt: opts.attempt,
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
          data: [...durableEvents],
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

    const handler = workflowEntrypoint(resilientWorkflow);
    const response = (await handler(
      new Request('https://example.test')
    )) as Response;
    return { response, createdEvents, createdEventParams, dehydratedInput };
  }

  it('materializes step_created from stepInput on a redelivery before executing', async () => {
    const { response, createdEvents, createdEventParams, dehydratedInput } =
      await driveStepMessage({
        runId: 'wrun_resilient_step_materialize',
        attempt: 2,
      });

    expect(response.status).toBe(204);
    // The re-ensure wrote the step_created with the message's payload…
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 'step_resilient_1',
        eventData: expect.objectContaining({
          stepName: 'resilientAdd',
          input: dehydratedInput,
        }),
      })
    );
    // …marked as a dispatch re-ensure so a guard-enforcing backend can refuse
    // it when the producer's write was 412-rejected (dispatch revoked).
    const ensureParamIdx = createdEvents.findIndex(
      (e) => e.eventType === 'step_created'
    );
    expect(createdEventParams[ensureParamIdx]).toMatchObject({
      viaStepDispatch: true,
    });
    // …and it preceded the step's start.
    const createdIdx = createdEvents.findIndex(
      (e) => e.eventType === 'step_created'
    );
    const startedIdx = createdEvents.findIndex(
      (e) => e.eventType === 'step_started'
    );
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeLessThan(startedIdx);
    // The queued step start carries the queue invocation's request provenance.
    const startIdx = createdEvents.findIndex(
      (e) => e.eventType === 'step_started'
    );
    expect(createdEventParams[startIdx]).toMatchObject({
      requestId: 'req_test',
    });
    // The step body ran and its terminal event was written.
    expect(stepBodySpy).toHaveBeenCalledWith(2, 3);
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'step_completed',
        correlationId: 'step_resilient_1',
      })
    );
  });

  it('skips the re-ensure on a first delivery (no per-step write overhead)', async () => {
    const { response, createdEvents } = await driveStepMessage({
      runId: 'wrun_resilient_step_first_delivery',
      attempt: 1,
    });

    expect(response.status).toBe(204);
    expect(
      createdEvents.filter((e) => e.eventType === 'step_created')
    ).toHaveLength(0);
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'step_completed',
        correlationId: 'step_resilient_1',
      })
    );
  });

  it('treats an EntityConflict re-ensure as the common already-created case', async () => {
    const { response, createdEvents } = await driveStepMessage({
      runId: 'wrun_resilient_step_conflict',
      attempt: 2,
      ensureError: new EntityConflictError('already exists'),
    });

    expect(response.status).toBe(204);
    // The conflict is swallowed and the step still executes to completion.
    expect(createdEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'step_completed',
        correlationId: 'step_resilient_1',
      })
    );
  });

  it('does not re-ensure when the message carries no stepInput (legacy dispatch)', async () => {
    const { response, createdEvents } = await driveStepMessage({
      runId: 'wrun_resilient_step_legacy',
      attempt: 2,
      omitStepInput: true,
    });

    expect(response.status).toBe(204);
    expect(
      createdEvents.filter((e) => e.eventType === 'step_created')
    ).toHaveLength(0);
  });

  // The load-bearing recovery: a FIRST delivery that beats (or outlives a
  // transient failure of) the producer's parallel step_created must
  // materialize the step and execute it within the same delivery. It cannot
  // wait for a redelivery — world-vercel's failure retries re-enqueue fresh
  // messages whose attempt resets to 1, so an attempt-gated recovery would
  // stall the step until the original message's ~300s visibility-timeout
  // redelivery (measured exactly so in the durabench parallel sweeps).
  it('recovers in-band on attempt 1 when the bare start rejects with step-not-found (world-vercel shape)', async () => {
    const { response, createdEvents, createdEventParams } =
      await driveStepMessage({
        runId: 'wrun_resilient_step_inband_vercel',
        attempt: 1,
        stepMissingError: new WorkflowWorldError(
          'workflow step step_resilient_1 not found',
          { status: 404 }
        ),
      });

    expect(response.status).toBe(204);
    // Order: failed bare start → re-ensured step_created (viaStepDispatch) →
    // successful start → completion, all in this delivery.
    const types = createdEvents.map((e) => e.eventType);
    expect(types).toEqual([
      'step_started',
      'step_created',
      'step_started',
      'step_completed',
    ]);
    const ensureIdx = types.indexOf('step_created');
    expect(createdEventParams[ensureIdx]).toMatchObject({
      viaStepDispatch: true,
    });
    // Both the failed bare start and the recovery start retain the current
    // invocation's provenance.
    for (const [index, event] of createdEvents.entries()) {
      if (event.eventType === 'step_started') {
        expect(createdEventParams[index]).toMatchObject({
          requestId: 'req_test',
        });
      }
    }
  });

  it('recovers in-band on attempt 1 with the local-world error shape (no status)', async () => {
    const { response, createdEvents } = await driveStepMessage({
      runId: 'wrun_resilient_step_inband_local',
      attempt: 1,
      stepMissingError: new WorkflowWorldError(
        'Step "step_resilient_1" not found'
      ),
    });

    expect(response.status).toBe(204);
    expect(createdEvents.map((e) => e.eventType)).toEqual([
      'step_started',
      'step_created',
      'step_started',
      'step_completed',
    ]);
  });

  it('propagates step-not-found without stepInput (nothing to recover from)', async () => {
    await expect(
      driveStepMessage({
        runId: 'wrun_resilient_step_inband_legacy',
        attempt: 1,
        omitStepInput: true,
        stepMissingError: new WorkflowWorldError(
          'workflow step step_resilient_1 not found',
          { status: 404 }
        ),
      })
    ).rejects.toThrow('not found');
  });
});

describe('workflowEntrypoint turbo mode', () => {
  const ORIG_TURBO = process.env.WORKFLOW_TURBO;
  const ORIG_OPT = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;

  // Default: turbo ON (unset) and the global optimistic flag OFF (unset).
  // Any optimistic behavior observed in these tests therefore comes from
  // turbo forcing it — never from WORKFLOW_OPTIMISTIC_INLINE_START.
  beforeEach(() => {
    delete process.env.WORKFLOW_TURBO;
    delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    turboOrder = [];
  });
  afterEach(() => {
    if (ORIG_TURBO === undefined) delete process.env.WORKFLOW_TURBO;
    else process.env.WORKFLOW_TURBO = ORIG_TURBO;
    if (ORIG_OPT === undefined) {
      delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    } else {
      process.env.WORKFLOW_OPTIMISTIC_INLINE_START = ORIG_OPT;
    }
    setWorld(undefined);
    vi.clearAllMocks();
    waitUntilPromises.length = 0;
  });

  const xform = (name: string) =>
    `;globalThis.__private_workflows = new Map();
     globalThis.__private_workflows.set(${JSON.stringify(name)}, ${name});`;

  // The step body records 'body' the moment it runs — its position relative to
  // 'run_started_resolved' / 'step_started_called' is what proves (or disproves)
  // optimistic start. Registered once; reads the current `turboOrder` binding.
  let turboOrder: string[] = [];
  registerStepFunction('turboStep', async () => {
    turboOrder.push('body');
    return undefined;
  });

  const oneStepWorkflow = `const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turboStep");
    async function workflow() { return await s(); }${xform('workflow')}`;

  // A step raced against a sleep: the suspension creates a wait, which makes
  // turbo exit (no forced optimistic start) for the inline step.
  const stepAndSleepWorkflow = `const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turboStep");
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      const [r] = await Promise.all([s(), sleep('1h')]);
      return r;
    }${xform('workflow')}`;

  async function makeRunInput(runId: string) {
    return {
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      deploymentId: 'test-deployment',
      workflowName: 'workflow',
      specVersion: SPEC_VERSION_CURRENT,
      executionContext: {},
    };
  }

  /**
   * Drives the handler with a first-invocation message (runInput present) at the
   * given delivery `attempt`. `runStartedGate`, when provided, holds the
   * `run_started` create until released — its resolution pushes
   * 'run_started_resolved' so tests can assert the body ran before or after it.
   */
  async function driveTurbo(opts: {
    runId: string;
    attempt: number;
    source: string;
    runStartedGate?: Promise<void>;
  }) {
    const { runId, attempt, source } = opts;
    const order = turboOrder;
    const durable: Event[] = [];
    let seq = 0;
    const rec = (data: any): Event => {
      seq += 1;
      const e = {
        eventId: slotToEventId(seq),
        runId,
        createdAt: new Date(),
        ...data,
      } as Event;
      durable.push(e);
      return e;
    };
    const runEntity: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        if (opts.runStartedGate) await opts.runStartedGate;
        order.push('run_started_resolved');
        return { run: runEntity, events: [] as Event[] };
      }
      if (data.eventType === 'step_started') {
        order.push('step_started_called');
        const d = data.eventData as { stepName?: string; input?: unknown };
        if (d?.input !== undefined) {
          rec({
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: data.correlationId,
            eventData: { stepName: d.stepName, input: d.input },
          });
        }
        return {
          event: rec(data),
          step: {
            runId,
            stepId: data.correlationId,
            stepName: d?.stepName,
            status: 'running' as const,
            attempt: 1,
            input: d?.input,
            startedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          ...(d?.input !== undefined ? { stepCreated: true } : {}),
        };
      }
      if (data.eventType === 'wait_created') order.push('wait_created');
      return { event: rec(data) };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => 'test-deployment'),
      createQueueHandler: vi.fn(
        (_p: string, handler: (m: unknown, md: unknown) => Promise<unknown>) =>
          async () => {
            await handler(
              {
                runId,
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
                runInput: await makeRunInput(runId),
              },
              {
                requestId: 'req_turbo',
                attempt,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_turbo',
              }
            );
            return new Response(null, { status: 204 });
          }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [...durable],
          hasMore: false,
          cursor: 'cursor_turbo',
        })),
      },
      runs: { get: vi.fn(async () => runEntity) },
      queue: vi.fn(async () => ({ messageId: null })),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handlerPromise = workflowEntrypoint(source)(
      new Request('https://example.test')
    ) as Promise<Response>;
    return { handlerPromise, order, eventsCreate };
  }

  it('backgrounds run_started and forces optimistic start on the first delivery', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const { handlerPromise, order, eventsCreate } = await driveTurbo({
      runId: 'wrun_turbo_first',
      attempt: 1,
      source: oneStepWorkflow,
      runStartedGate: gate,
    });

    // The body runs while run_started is still in flight — proving run_started
    // was backgrounded AND optimistic start was forced (the env flag is off).
    // The full VM replay leading up to the body can exceed vi.waitFor's default
    // 1s timeout on slow CI runners (notably Windows), so widen it.
    await vi.waitFor(() => expect(order).toContain('body'), {
      timeout: 15_000,
    });
    expect(order).not.toContain('run_started_resolved');
    // The lazy step_started is chained on the run-ready barrier, so it is not
    // even issued until run_started lands.
    expect(order).not.toContain('step_started_called');

    release();
    const res = await handlerPromise;
    expect(res.status).toBe(204);
    // After release: step_started fires, ordered strictly after run_started.
    expect(order).toContain('step_started_called');
    expect(order.indexOf('run_started_resolved')).toBeLessThan(
      order.indexOf('step_started_called')
    );
    // run_started was created exactly once (idempotent first write).
    const runStartedCreates = eventsCreate.mock.calls.filter(
      (c) => (c[1] as any).eventType === 'run_started'
    );
    expect(runStartedCreates).toHaveLength(1);
  });

  it('does not turbo on a redelivery (attempt > 1): run_started is awaited first', async () => {
    const { handlerPromise, order } = await driveTurbo({
      runId: 'wrun_turbo_redeliver',
      attempt: 2,
      source: oneStepWorkflow,
    });

    const res = await handlerPromise;
    expect(res.status).toBe(204);
    // Non-turbo awaits run_started up front, so the body runs strictly after it.
    expect(order.indexOf('run_started_resolved')).toBeLessThan(
      order.indexOf('body')
    );
  });

  it('does not turbo when WORKFLOW_TURBO=0 (parity with the awaited path)', async () => {
    process.env.WORKFLOW_TURBO = '0';
    const { handlerPromise, order } = await driveTurbo({
      runId: 'wrun_turbo_off',
      attempt: 1,
      source: oneStepWorkflow,
    });

    const res = await handlerPromise;
    expect(res.status).toBe(204);
    expect(order.indexOf('run_started_resolved')).toBeLessThan(
      order.indexOf('body')
    );
  });

  it('asks the World to skip the run_started preload only under turbo', async () => {
    // The backgrounded run_started is used purely as a write barrier and its
    // preloaded events are never read (preloadedEvents is forced to []), so
    // turbo passes skipPreload to drop the wasted server-side
    // list+resolve that the chained first step_started waits behind.
    const turbo = await driveTurbo({
      runId: 'wrun_turbo_skip_preload',
      attempt: 1,
      source: oneStepWorkflow,
    });
    expect((await turbo.handlerPromise).status).toBe(204);
    const turboRunStarted = turbo.eventsCreate.mock.calls.find(
      (c) => (c[1] as any).eventType === 'run_started'
    );
    expect((turboRunStarted?.[2] as any)?.skipPreload).toBe(true);

    // A redelivery (attempt > 1) is not turbo: it awaits run_started and
    // consumes the preload to skip its initial events.list, so it must NOT ask
    // the server to skip it.
    const redeliver = await driveTurbo({
      runId: 'wrun_turbo_skip_preload_redeliver',
      attempt: 2,
      source: oneStepWorkflow,
    });
    expect((await redeliver.handlerPromise).status).toBe(204);
    const redeliverRunStarted = redeliver.eventsCreate.mock.calls.find(
      (c) => (c[1] as any).eventType === 'run_started'
    );
    expect((redeliverRunStarted?.[2] as any)?.skipPreload).toBeUndefined();
  });

  it('never asks for an inline delta on a run-terminal write, or anywhere under turbo', async () => {
    const turbo = await driveTurbo({
      runId: 'wrun_turbo_no_delta',
      attempt: 1,
      source: oneStepWorkflow,
    });
    expect((await turbo.handlerPromise).status).toBe(204);
    // Turbo exists to keep the first invocation's writes as cheap as
    // possible and starts with no loaded log to extend, so nothing it writes
    // asks the World to compute a delta.
    expect(
      turbo.eventsCreate.mock.calls.map((c) => (c[2] as any)?.sinceCursor)
    ).toEqual(turbo.eventsCreate.mock.calls.map(() => undefined));

    // A redelivery is not turbo and has a cursor by the time the run
    // finishes, but nothing reads the log after a run-terminal write, so the
    // delta would be work the World does for no one.
    const redeliver = await driveTurbo({
      runId: 'wrun_turbo_no_delta_redeliver',
      attempt: 2,
      source: oneStepWorkflow,
    });
    expect((await redeliver.handlerPromise).status).toBe(204);
    const runCompleted = redeliver.eventsCreate.mock.calls.find(
      (c) => (c[1] as any).eventType === 'run_completed'
    );
    expect(runCompleted).toBeDefined();
    expect((runCompleted?.[2] as any)?.sinceCursor).toBeUndefined();
  });

  it('exits turbo (no forced optimistic) when the suspension creates a wait', async () => {
    const { handlerPromise, order } = await driveTurbo({
      runId: 'wrun_turbo_wait',
      attempt: 1,
      source: stepAndSleepWorkflow,
    });

    const res = await handlerPromise;
    expect(res.status).toBe(204);
    // A wait was created this suspension, so turbo exited: the inline step took
    // the normal await-then-run path, i.e. step_started was awaited BEFORE the
    // body ran (the opposite ordering from the forced-optimistic case above).
    expect(order).toContain('wait_created');
    expect(order.indexOf('step_started_called')).toBeLessThan(
      order.indexOf('body')
    );
  });
});

describe('workflowEntrypoint inline-delta gate with open hooks', () => {
  const ORIG_OPT = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;

  beforeEach(() => {
    delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    deltaGateBodyRuns = [];
  });
  afterEach(() => {
    if (ORIG_OPT === undefined) {
      delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    } else {
      process.env.WORKFLOW_OPTIMISTIC_INLINE_START = ORIG_OPT;
    }
    setWorld(undefined);
    vi.clearAllMocks();
    waitUntilPromises.length = 0;
  });

  registerStepFunction('deltaGateStep', async () => undefined);
  let deltaGateBodyRuns: string[] = [];
  registerStepFunction('deltaGateStepB', async () => {
    deltaGateBodyRuns.push('B');
    return undefined;
  });

  // A fire-and-forget hook alongside a single awaited step: the suspension
  // creates a hook AND schedules one lazy inline step, leaving the hook open
  // for the rest of the run.
  const hookAndStepWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("deltaGateStep");
    async function workflow() {
      const hook = createHook({ token: 'delta-gate-token' });
      return await s();
    };globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`;

  // Same open hook, but two sequential steps — used to interleave an
  // out-of-band event between step A's completion and step B's claim.
  const hookAndTwoStepWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    const a = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("deltaGateStep");
    const b = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("deltaGateStepB");
    async function workflow() {
      const hook = createHook({ token: 'delta-gate-token' });
      await a();
      return await b();
    };globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`;

  /**
   * Drives the handler with a continuation message (no runInput, so turbo is
   * off and the initial events.list — which supplies the cursor the delta
   * diffs against — runs). Returns the events.create mock so tests can
   * inspect the step-terminal write's params for `sinceCursor` and the
   * step_started claims' params for `eventCount`.
   */
  async function driveDeltaGate(
    runId: string,
    opts: {
      /**
       * World capabilities to declare. Absent by default — capability-gated
       * fast paths must fail closed without them.
       */
      capabilities?: { maxConcurrency?: boolean };
      /** Workflow source to run (defaults to hookAndStepWorkflow). */
      source?: string;
      /**
       * Reject the lazy step_started claim for this stepName with the given
       * error (once), simulating a guard-enforcing backend 412-ing a stale
       * claim after an out-of-band event bumped the run's marker.
       */
      rejectClaimOnce?: { stepName: string; error: Error };
    } = {}
  ) {
    const workflowRun: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    const durableEvents: Event[] = [];
    const recordEvent = (data: any): Event => {
      // Slot-numbered event ids, so the runtime's snapshot (the highest slot
      // its loaded log occupies) is computable. This is the only kind of run
      // that reaches a fencing backend.
      const created = {
        eventId: slotToEventId(durableEvents.length + 1),
        runId,
        createdAt: new Date(),
        ...data,
      } as Event;
      durableEvents.push(created);
      return created;
    };

    let claimRejected = false;
    const eventsCreate = vi.fn(
      async (_runId: string, data: any, _params?: any) => {
        if (data.eventType === 'run_started') {
          return { run: workflowRun, events: [] as Event[] };
        }
        if (data.eventType === 'step_started') {
          const lazy = data.eventData as {
            stepName?: string;
            input?: unknown;
          };
          if (
            opts.rejectClaimOnce &&
            !claimRejected &&
            lazy?.stepName === opts.rejectClaimOnce.stepName
          ) {
            claimRejected = true;
            throw opts.rejectClaimOnce.error;
          }
          if (lazy?.input !== undefined) {
            recordEvent({
              eventType: 'step_created',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: data.correlationId,
              eventData: { stepName: lazy.stepName, input: lazy.input },
            });
          }
          return {
            event: recordEvent(data),
            step: {
              runId,
              stepId: data.correlationId,
              stepName: lazy?.stepName,
              status: 'running' as const,
              attempt: 1,
              input: lazy?.input,
              startedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            ...(lazy?.input !== undefined ? { stepCreated: true } : {}),
          };
        }
        // The World returns no delta (like a World that doesn't support
        // sinceCursor), so the next iteration falls back to events.list —
        // these tests only assert whether the delta was REQUESTED.
        return { event: recordEvent(data) };
      }
    );

    const queueMock = vi.fn(async () => ({ messageId: null }));
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: opts.capabilities,
      createQueueHandler: vi.fn(
        (
          _prefix: string,
          handler: (message: unknown, metadata: unknown) => Promise<unknown>
        ) => {
          return async () => {
            await handler(
              {
                runId,
                requestedAt: new Date('2024-01-01T00:00:00.000Z'),
              },
              {
                requestId: 'req_delta_gate',
                attempt: 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_delta_gate',
              }
            );
            return new Response(null, { status: 204 });
          };
        }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [...durableEvents],
          hasMore: false,
          cursor: 'cursor_delta_gate',
        })),
      },
      runs: { get: vi.fn(async () => workflowRun) },
      queue: queueMock,
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const handler = workflowEntrypoint(opts.source ?? hookAndStepWorkflow);
    const res = (await handler(
      new Request('https://example.test')
    )) as Response;
    return { res, eventsCreate, queueMock };
  }

  function stepCompletedParams(eventsCreate: ReturnType<typeof vi.fn>) {
    const call = eventsCreate.mock.calls.find(
      (c) => (c[1] as any).eventType === 'step_completed'
    );
    expect(call).toBeDefined();
    return call?.[2] as { sinceCursor?: string } | undefined;
  }

  it('requests the inline delta despite the open hook', async () => {
    const { res, eventsCreate } = await driveDeltaGate(
      'wrun_delta_gate_guard_on'
    );
    expect(res.status).toBe(204);
    // The suspension created a hook (left open) and one lazy inline step. A
    // hook_received missed by the delta window is fenced by the outside-event
    // marker, so the fast path stays active.
    expect(stepCompletedParams(eventsCreate)?.sinceCursor).toBe(
      'cursor_delta_gate'
    );
    expect(eventsCreate.mock.calls).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'hook_created' }),
      ])
    );
  });

  it('restarts the replay in-process and still completes the run when a stale lazy claim is rejected by the guard (interleaved hook_received)', async () => {
    // Simulates the interleaving the fence exists for: after step A's
    // terminal write, an out-of-band hook_received bumps the run's marker;
    // the next replay (working from a view that misses it) schedules step B,
    // whose lazy step_started claim the backend rejects as stale (412).
    const { res, eventsCreate, queueMock } = await driveDeltaGate(
      'wrun_delta_gate_stale_claim',
      {
        source: hookAndTwoStepWorkflow,
        rejectClaimOnce: {
          stepName: 'deltaGateStepB',
          error: new PreconditionFailedError(
            'stale snapshot: a newer outside event exists'
          ),
        },
      }
    );
    // The handler responds normally: the rejection restarts the replay inside
    // this delivery, never a run_failed.
    expect(res.status).toBe(204);
    // Step B's claim was issued from a loaded (non-empty) log, so it named the
    // position it was decided against. (The very first batch of a run loads an
    // empty log and has no position to name; reporting is best-effort there,
    // matching the suspension creates.)
    const rejectedClaim = eventsCreate.mock.calls.find(
      (c) =>
        (c[1] as any).eventType === 'step_started' &&
        ((c[1] as any).eventData as { stepName?: string })?.stepName ===
          'deltaGateStepB'
    );
    expect(typeof (rejectedClaim?.[2] as any)?.eventCount).toBe('number');
    // The fenced claim's body never ran: step B executes exactly once, on the
    // restarted replay whose claim the backend accepted.
    expect(deltaGateBodyRuns).toEqual(['B']);
    expect(eventsCreate.mock.calls).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'step_completed',
          eventData: expect.objectContaining({ stepName: 'deltaGateStepB' }),
        }),
      ])
    );
    // The restart is in-process, so the run reaches its terminal event inside
    // this same delivery — no re-invocation, and no run failure.
    expect(eventsCreate.mock.calls).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run_completed' }),
      ])
    );
    expect(eventsCreate.mock.calls).not.toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run_failed' }),
      ])
    );
    expect(queueMock).not.toHaveBeenCalled();
  });

  it('suppresses optimistic start on guarded stale-sensitive batches: a 412-fenced step never runs its body even with WORKFLOW_OPTIMISTIC_INLINE_START=1', async () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '1';
    // Same interleaving as above, but with optimistic start enabled globally.
    // Without suppression, executeStep would begin step B's body immediately
    // (before the claim settles) and only discard the result after the 412 —
    // the side effects would already have run, and the restarted replay would
    // run them a second time. With an open hook and the guard in force, the
    // runtime takes the await-then-run path instead, so the fence covers user
    // code: the body runs exactly once, after an accepted claim.
    const { res, eventsCreate } = await driveDeltaGate(
      'wrun_delta_gate_stale_claim_optimistic',
      {
        source: hookAndTwoStepWorkflow,
        rejectClaimOnce: {
          stepName: 'deltaGateStepB',
          error: new PreconditionFailedError(
            'stale snapshot: a newer outside event exists'
          ),
        },
      }
    );
    expect(res.status).toBe(204);
    expect(deltaGateBodyRuns).toEqual(['B']);
    expect(eventsCreate.mock.calls).not.toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'run_failed' }),
      ])
    );
  });
});

describe('workflowEntrypoint latency telemetry (ttfs / stso)', () => {
  const ORIG_TURBO = process.env.WORKFLOW_TURBO;

  beforeEach(() => {
    delete process.env.WORKFLOW_TURBO;
  });
  afterEach(() => {
    if (ORIG_TURBO === undefined) delete process.env.WORKFLOW_TURBO;
    else process.env.WORKFLOW_TURBO = ORIG_TURBO;
    setWorld(undefined);
    vi.clearAllMocks();
    waitUntilPromises.length = 0;
  });

  registerStepFunction('latStepOne', async () => undefined);
  registerStepFunction('latStepTwo', async () => undefined);

  const latXform = (name: string) =>
    `;globalThis.__private_workflows = new Map();
     globalThis.__private_workflows.set(${JSON.stringify(name)}, ${name});`;

  const twoStepWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("latStepOne");
    const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("latStepTwo");
    async function workflow() { await s1(); return await s2(); }${latXform('workflow')}`;

  // The first step races a long sleep: the suspension that schedules the
  // step also creates a wait, which must disqualify the measurement.
  const stepRacingSleepWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("latStepOne");
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      const [r] = await Promise.all([s1(), sleep('1h')]);
      return r;
    }${latXform('workflow')}`;

  /** Backdated `wrun_` ULID so a real TTFS (≈ backdateMs) is computable. */
  function makeLatencyRunId(backdateMs: number): string {
    return `wrun_${ulid(Date.now() - backdateMs)}`;
  }

  /**
   * Same as {@link makeLatencyRunId} but with the run-ID tagging schemes'
   * metadata tag bit set (the MSB of the ULID's 48-bit timestamp, e.g.
   * world-vercel's region-tagged IDs). For present-day timestamps the ULID's
   * leading character is '0', so setting the tag bit turns it into a '4'.
   */
  function makeTaggedLatencyRunId(backdateMs: number): string {
    const plain = ulid(Date.now() - backdateMs);
    if (plain[0] !== '0') throw new Error('expected untagged leading char');
    return `wrun_4${plain.slice(1)}`;
  }

  async function driveLatency(opts: {
    runId: string;
    source: string;
    attempt?: number;
    /** Pre-existing durable log (an earlier invocation's writes). */
    seedEvents?: Event[];
    /** false simulates a queue continuation delivery (no runInput → no turbo). */
    withRunInput?: boolean;
  }) {
    const { runId, source } = opts;
    const durable: Event[] = [...(opts.seedEvents ?? [])];
    let seq = durable.length;
    const rec = (data: any): Event => {
      seq += 1;
      const e = {
        eventId: slotToEventId(seq),
        runId,
        createdAt: new Date(),
        ...data,
      } as Event;
      durable.push(e);
      return e;
    };
    const runEntity: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(),
      startedAt: new Date(),
      deploymentId: 'test-deployment',
    };
    const queued: unknown[] = [];

    const eventsCreate = vi.fn(async (_runId: string, data: any) => {
      if (data.eventType === 'run_started') {
        // Preload mirrors the real server: the durable log as of now.
        return { run: runEntity, events: [...durable] };
      }
      if (data.eventType === 'step_started') {
        const d = data.eventData as { stepName?: string; input?: unknown };
        if (d?.input !== undefined) {
          rec({
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: data.correlationId,
            eventData: { stepName: d.stepName, input: d.input },
          });
        }
        return {
          event: rec(data),
          step: {
            runId,
            stepId: data.correlationId,
            stepName: d?.stepName,
            status: 'running' as const,
            attempt: 1,
            input: d?.input,
            startedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          ...(d?.input !== undefined ? { stepCreated: true } : {}),
        };
      }
      return { event: rec(data) };
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn(async () => 'test-deployment'),
      createQueueHandler: vi.fn(
        (_p: string, handler: (m: unknown, md: unknown) => Promise<unknown>) =>
          async () => {
            await handler(
              {
                runId,
                requestedAt: new Date(),
                ...(opts.withRunInput === false
                  ? {}
                  : {
                      runInput: {
                        input: await dehydrateWorkflowArguments(
                          [],
                          runId,
                          undefined,
                          []
                        ),
                        deploymentId: 'test-deployment',
                        workflowName: 'workflow',
                        specVersion: SPEC_VERSION_CURRENT,
                        executionContext: {},
                      },
                    }),
              },
              {
                requestId: 'req_latency',
                attempt: opts.attempt ?? 1,
                queueName: '__wkf_workflow_workflow',
                messageId: 'msg_latency',
              }
            );
            return new Response(null, { status: 204 });
          }
      ),
      events: {
        create: eventsCreate,
        list: vi.fn(async () => ({
          data: [...durable],
          hasMore: false,
          cursor: 'cursor_latency',
        })),
      },
      runs: { get: vi.fn(async () => runEntity) },
      queue: vi.fn(async (_queueName: string, message: unknown) => {
        queued.push(message);
        return { messageId: null };
      }),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    const res = (await workflowEntrypoint(source)(
      new Request('https://example.test')
    )) as Response;
    expect(res.status).toBe(204);

    const stepCompleted = eventsCreate.mock.calls
      .map((c) => c[1] as any)
      .filter((d) => d.eventType === 'step_completed');
    return { stepCompleted, eventsCreate, queued };
  }

  it('attaches ttfs to the first step and stso to the next back-to-back step (turbo)', async () => {
    const backdateMs = 5_000;
    const before = Date.now();
    const { stepCompleted } = await driveLatency({
      runId: makeLatencyRunId(backdateMs),
      source: twoStepWorkflow,
    });
    const elapsed = Date.now() - before;
    expect(stepCompleted).toHaveLength(2);

    const [first, second] = stepCompleted;
    // First step: TTFS anchored at the run-id ULID timestamp, no STSO.
    expect(first.eventData.ttfs).toBeGreaterThanOrEqual(backdateMs);
    expect(first.eventData.ttfs).toBeLessThanOrEqual(backdateMs + elapsed);
    expect(first.eventData.stso).toBeUndefined();
    expect(first.eventData.optimizations).toEqual([
      'turbo',
      'lazyStepStart',
      'optimisticStart',
    ]);

    // RSFS/finalSchedulingReplay: under turbo, rsfsAnchorMs is stamped at local run
    // synthesis (well after the backdated run-id timestamp), so unlike ttfs
    // it stays within the test's own wall-clock budget.
    expect(first.eventData.rsfs).toBeGreaterThanOrEqual(0);
    expect(first.eventData.rsfs).toBeLessThanOrEqual(elapsed);
    expect(first.eventData.finalSchedulingReplay).toBeGreaterThanOrEqual(0);
    expect(first.eventData.finalSchedulingReplay).toBeLessThanOrEqual(elapsed);

    // Second step ran back-to-back with the first: STSO only, and far
    // smaller than the TTFS anchor distance (it measures the scheduling
    // gap, not run age).
    expect(second.eventData.ttfs).toBeUndefined();
    expect(second.eventData.stso).toBeGreaterThanOrEqual(0);
    expect(second.eventData.stso).toBeLessThanOrEqual(elapsed);
    expect(second.eventData.stepCount).toBe(1);
    expect(second.eventData.eventCount).toBeGreaterThan(0);
    // `retained` is per-pass, not per-invocation: the first step's pass built
    // the VM (a full replay, so no flag above), the second step's pass
    // resumed the session this same invocation retained.
    expect(second.eventData.optimizations).toEqual([
      'turbo',
      'lazyStepStart',
      'optimisticStart',
      'retained',
    ]);
    // STSO-only steps never qualify for RSFS (it shares TTFS eligibility),
    // but finalSchedulingReplay is ungated — reported for any batch STSO is,
    // not just the run's first step.
    expect(second.eventData.rsfs).toBeUndefined();
    expect(second.eventData.finalSchedulingReplay).toBeGreaterThanOrEqual(0);
    expect(second.eventData.finalSchedulingReplay).toBeLessThanOrEqual(elapsed);
  });

  it('anchors ttfs correctly for a region-tagged run ID (tag bit cleared, not a future timestamp)', async () => {
    const backdateMs = 5_000;
    const before = Date.now();
    const { stepCompleted } = await driveLatency({
      runId: makeTaggedLatencyRunId(backdateMs),
      source: twoStepWorkflow,
    });
    const elapsed = Date.now() - before;

    // With the tag bit decoded as part of the timestamp the anchor would sit
    // millennia in the future and the sample would be dropped (or, worse,
    // clamp to an exact 0). Instead the tag bit is cleared and TTFS reflects
    // the real run age.
    const [first] = stepCompleted;
    expect(first.eventData.ttfs).toBeGreaterThanOrEqual(backdateMs);
    expect(first.eventData.ttfs).toBeLessThanOrEqual(backdateMs + elapsed);
  });

  it('still reports ttfs without turbo (redelivery), minus turbo-only optimization flags', async () => {
    const backdateMs = 5_000;
    const { stepCompleted } = await driveLatency({
      runId: makeLatencyRunId(backdateMs),
      source: twoStepWorkflow,
      attempt: 2, // redelivery → turbo off, awaited run_started path
    });
    expect(stepCompleted).toHaveLength(2);
    const [first] = stepCompleted;
    expect(first.eventData.ttfs).toBeGreaterThanOrEqual(backdateMs);
    expect(first.eventData.optimizations).toEqual(['lazyStepStart']);
    // Non-turbo: rsfsAnchorMs is stamped right after the real (awaited)
    // run_started response, so rsfs is a small non-negative duration too.
    expect(first.eventData.rsfs).toBeGreaterThanOrEqual(0);
    expect(first.eventData.finalSchedulingReplay).toBeGreaterThanOrEqual(0);
  });

  it('reports nothing when the first step is scheduled alongside a wait', async () => {
    const { stepCompleted } = await driveLatency({
      runId: makeLatencyRunId(5_000),
      source: stepRacingSleepWorkflow,
    });
    expect(stepCompleted).toHaveLength(1);
    expect(stepCompleted[0].eventData.ttfs).toBeUndefined();
    expect(stepCompleted[0].eventData.stso).toBeUndefined();
    expect(stepCompleted[0].eventData.rsfs).toBeUndefined();
    expect(stepCompleted[0].eventData.finalSchedulingReplay).toBeUndefined();
    expect(stepCompleted[0].eventData.optimizations).toBeUndefined();
  });

  const attrThenStepWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("latStepOne");
    const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
    async function workflow() {
      await setAttributes([{ key: "k", value: "v" }]);
      return await s1();
    }${latXform('workflow')}`;

  it('reports ttfs across a pre-step setAttributes, resolved in-process without a re-invoke', async () => {
    // A workflow-body setAttributes before the first step resolves through
    // an in-process replay: the same delivery commits attr_set, replays, and
    // runs the step — no queue interaction. TTFS ends at the attr write, so
    // the setAttributes call's duration is subtracted; here that detour is
    // milliseconds, keeping ttfs ≈ the run's ULID backdate.
    const backdateMs = 10_000;
    const before = Date.now();
    const first = await driveLatency({
      runId: makeLatencyRunId(backdateMs),
      source: attrThenStepWorkflow,
    });
    const elapsed = Date.now() - before;

    // Everything happened in this one delivery: attr committed, step run,
    // and nothing was enqueued (no re-invoke, no step dispatch).
    const attrCreates = first.eventsCreate.mock.calls
      .map((c) => c[1] as any)
      .filter((d) => d.eventType === 'attr_set');
    expect(attrCreates).toHaveLength(1);
    expect(first.stepCompleted).toHaveLength(1);
    expect(first.queued).toEqual([]);

    const { ttfs, stso, optimizations } = first.stepCompleted[0].eventData;
    expect(ttfs).toBeGreaterThanOrEqual(backdateMs);
    expect(ttfs).toBeLessThanOrEqual(backdateMs + elapsed);
    expect(stso).toBeUndefined();
    // The attr detour does not end turbo: no resume invocation source
    // exists, so the forced-optimistic fast path stays engaged.
    expect(optimizations).toEqual([
      'turbo',
      'lazyStepStart',
      'optimisticStart',
    ]);
  });

  it('reports ttfs when a redelivery lands after a committed pre-step attr_set, ending the measurement at the attr write', async () => {
    // Both measurement endpoints are values this test controls (the run-id
    // ULID timestamp and the crafted attr occurredAt), so the expected ttfs
    // is exact — no wall-clock slack that a slow CI runner could exceed.
    const runCreatedAtMs = Date.now() - 10_000;
    const runId = `wrun_${ulid(runCreatedAtMs)}`;

    // Harvest a replay-consumable attr_set by driving the workflow once:
    // its correlationId is a deterministic replay ULID, so only an event
    // captured from a real drive of the SAME run id resolves the
    // setAttributes call on the next drive's replay.
    const harvest = await driveLatency({
      runId,
      source: attrThenStepWorkflow,
    });
    const attrCreates = harvest.eventsCreate.mock.calls
      .map((c) => c[1] as any)
      .filter((d) => d.eventType === 'attr_set');
    expect(attrCreates).toHaveLength(1);

    // Simulate a redelivery landing after the attr_set was committed but
    // before the first step ran: a fresh world seeded with only the attr
    // event, stamped as written 7s after run creation. The measurement must
    // end at the attr write: exactly 7s, NOT the full wall-clock distance
    // to now (10s+).
    const attrOccurredAt = new Date(runCreatedAtMs + 7_000);
    const attrEvent = {
      ...attrCreates[0],
      eventId: slotToEventId(1),
      runId,
      createdAt: attrOccurredAt,
      occurredAt: attrOccurredAt,
    } as Event;

    const redelivery = await driveLatency({
      runId,
      source: attrThenStepWorkflow,
      seedEvents: [attrEvent],
      withRunInput: false,
    });
    expect(redelivery.stepCompleted).toHaveLength(1);
    const { ttfs, stso, optimizations } = redelivery.stepCompleted[0].eventData;
    // ULID time encoding is millisecond-exact, so this is deterministic.
    expect(ttfs).toBe(+attrOccurredAt - runCreatedAtMs);
    expect(stso).toBeUndefined();
    // Continuation delivery is not turbo.
    expect(optimizations).toEqual(['lazyStepStart']);
  });
});
