/**
 * Pins the QuickJS engine's optimistic-concurrency precondition guard:
 * every replay-context event write must carry the view snapshot
 * (`stateUpdatedAt` / `stateEventCount`) describing the event log the
 * invocation derived the write from, so a supporting World can reject a
 * stale writer with 412 — parity with the node:vm engine's `createGuarded`
 * (suspension-handler.ts) and guarded `run_completed`. The terminal
 * `run_failed` is deliberately unfenced (same asymmetry as the node
 * engine: a failing run must be able to terminate from a stale view).
 *
 * The QuickJS VM itself is mocked — the guard lives entirely in the
 * entrypoint's write paths.
 */
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../serialization.js';
import { latestEventStateUpdatedAt } from './helpers.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

const ulid = monotonicFactory();

function makeEvent(
  eventType: string,
  overrides: Partial<Record<string, unknown>> = {}
): Event {
  return {
    eventId: `evnt_${ulid()}`,
    runId: 'wrun_quickjs_fencing',
    eventType,
    eventData: {},
    createdAt: new Date('2026-05-19T12:00:00.000Z'),
    ...overrides,
  } as unknown as Event;
}

async function runScenario(options: {
  events: Event[];
  vmResult: Record<string, unknown>;
}) {
  const runId = 'wrun_quickjs_fencing';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_quickjs_fencing',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  const created: {
    request: CreateEventRequest;
    params: Record<string, unknown> | undefined;
  }[] = [];
  let listCallCount = 0;
  const listEvents = vi.fn(async () => {
    listCallCount++;
    if (listCallCount === 1) {
      return {
        data: [...options.events],
        cursor: options.events.at(-1)?.eventId ?? null,
        hasMore: false,
      };
    }
    return { data: [], cursor: null, hasMore: false };
  });
  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: Record<string, unknown>
    ) => {
      created.push({ request, params });
      return { event: { ...request, runId, eventId: `evnt_${ulid()}` } };
    }
  );

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { preconditionGuard: true },
    events: { list: listEvents, create: createEvent },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_quickjs' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  startQuickJSWorkflow.mockResolvedValue({
    result: options.vmResult,
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  });

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// mocked VM',
    workflowName: 'workflow',
    workflowRun,
    preloadedEvents: options.events,
    preloadedEventsComplete: true,
  });

  return { created };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('QuickJS entrypoint precondition guard', () => {
  const baseLog = () => [
    makeEvent('run_created', { eventData: { input: undefined } }),
    makeEvent('run_started'),
  ];

  it('fences run_completed with the view snapshot', async () => {
    const events = baseLog();
    const { created } = await runScenario({
      events,
      vmResult: {
        completed: {
          result: await dehydrateStepReturnValue(
            'done',
            'wrun_quickjs_fencing',
            undefined
          ),
        },
      },
    });

    const runCompleted = created.find(
      (c) => c.request.eventType === 'run_completed'
    );
    expect(runCompleted).toBeDefined();
    expect(runCompleted?.params).toMatchObject({
      stateUpdatedAt: latestEventStateUpdatedAt(events),
      stateEventCount: events.length,
    });
  });

  it('fences suspension writes (hook_created, wait_created) with the view snapshot', async () => {
    const events = baseLog();
    const { created } = await runScenario({
      events,
      vmResult: {
        suspended: {
          pendingOperations: [
            {
              type: 'hook',
              correlationId: 'hook_01FENCE',
              token: 'fence-token',
              isWebhook: false,
              hasCreatedEvent: false,
            },
            {
              type: 'wait',
              correlationId: 'wait_01FENCE',
              // Far future so the loop schedules a continuation instead of
              // completing the wait.
              resumeAt: '2027-01-01T00:00:00.000Z',
              hasCreatedEvent: false,
            },
          ],
        },
      },
    });

    const expected = {
      stateUpdatedAt: latestEventStateUpdatedAt(events),
      stateEventCount: events.length,
    };
    const hookCreated = created.find(
      (c) => c.request.eventType === 'hook_created'
    );
    const waitCreated = created.find(
      (c) => c.request.eventType === 'wait_created'
    );
    expect(hookCreated?.params).toMatchObject(expected);
    expect(waitCreated?.params).toMatchObject(expected);
  });

  it('fences the elapsed-wait completion and carries the wait resumeAt', async () => {
    // The wait elapsed before this invocation, so the pre-VM pass writes
    // its wait_completed. The event must carry resumeAt (shape parity with
    // the node engine's elapsed-wait completion, and the input to the
    // replay-divergence resumeAt identity check) and the view snapshot.
    const resumeAt = '2026-05-19T12:00:01.000Z';
    const events = [
      ...baseLog(),
      makeEvent('wait_created', {
        correlationId: 'wait_01ELAPSED',
        eventData: { resumeAt },
      }),
    ];
    // The write's snapshot describes the log BEFORE the self-written
    // wait_completed (which the entrypoint splices into `events`) — capture
    // the expectation up front.
    const expectedSnapshot = {
      stateUpdatedAt: latestEventStateUpdatedAt(events),
      stateEventCount: events.length,
    };
    const { created } = await runScenario({
      events,
      vmResult: {
        completed: {
          result: await dehydrateStepReturnValue(
            'done',
            'wrun_quickjs_fencing',
            undefined
          ),
        },
      },
    });

    const waitCompleted = created.find(
      (c) => c.request.eventType === 'wait_completed'
    );
    expect(waitCompleted).toBeDefined();
    expect(
      (waitCompleted?.request.eventData as { resumeAt?: Date })?.resumeAt
    ).toEqual(new Date(resumeAt));
    expect(waitCompleted?.params).toMatchObject(expectedSnapshot);
  });

  it('leaves run_failed unfenced (terminal-failure asymmetry)', async () => {
    const { created } = await runScenario({
      events: baseLog(),
      vmResult: {
        failed: { message: 'boom', name: 'Error' },
      },
    });

    const runFailed = created.find((c) => c.request.eventType === 'run_failed');
    expect(runFailed).toBeDefined();
    expect(runFailed?.params).toBeUndefined();
  });

  it('sends no snapshot when the guard is disabled', async () => {
    vi.stubEnv('WORKFLOW_PRECONDITION_GUARD', '0');
    const { created } = await runScenario({
      events: baseLog(),
      vmResult: {
        completed: {
          result: await dehydrateStepReturnValue(
            'done',
            'wrun_quickjs_fencing',
            undefined
          ),
        },
      },
    });

    const runCompleted = created.find(
      (c) => c.request.eventType === 'run_completed'
    );
    expect(runCompleted?.params ?? {}).not.toHaveProperty('stateUpdatedAt');
  });
});
