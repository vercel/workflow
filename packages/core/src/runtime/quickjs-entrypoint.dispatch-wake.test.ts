/**
 * Pins the QuickJS engine's suspension tail arming the re-dispatch watchdog
 * wake, and arming it independently of the wait continuation.
 *
 * A pending step whose `step_created` is durable is neither an inline
 * candidate nor an overflow dispatch (both require a step with no created
 * event), so its dispatch is already out there and the only thing that brings a
 * replay back to notice it stopped short of a terminal event is the boundary
 * wake. A run that also holds a pending wait must still get that wake: the wait
 * can be hours out, and until it elapses nothing else replays the run.
 *
 * The QuickJS VM itself is mocked (its WASM import chain is irrelevant to what
 * the tail queues): `startQuickJSWorkflow` reports the suspension directly.
 */
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStepDispatchWake,
  nextStepDispatchBoundaryMs,
} from './step-dispatch.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

const RUN_ID = 'wrun_quickjs_dispatch_wake';
const STEP_CID = 'step_lost_dispatch';
const WAIT_CID = 'wait_far_future';
const RUN_STARTED_AT = new Date('2026-05-19T12:00:00.000Z');

/**
 * A durable log holding a created-but-unstarted step and a pending wait. The
 * step's creation is dated far enough back that its dispatch is presumed lost
 * under any watchdog interval the env allows, and the wait resumes well past
 * every watchdog boundary so it can never be the sooner of the two timers.
 */
function makeLog(stepCreatedAt: Date, waitResumeAt: Date): Event[] {
  let slot = 0;
  const event = (data: Record<string, unknown>, createdAt: Date): Event =>
    ({
      specVersion: SPEC_VERSION_CURRENT,
      ...data,
      runId: RUN_ID,
      eventId: `evnt_${String(++slot).padStart(26, '0')}`,
      createdAt,
    }) as Event;
  return [
    event(
      {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'dpl_quickjs_dispatch_wake',
          workflowName: 'workflow',
          input: [],
        },
      },
      RUN_STARTED_AT
    ),
    event({ eventType: 'run_started' }, RUN_STARTED_AT),
    event(
      {
        eventType: 'step_created',
        correlationId: STEP_CID,
        eventData: { stepId: 'lostStep' },
      },
      stepCreatedAt
    ),
    event(
      {
        eventType: 'wait_created',
        correlationId: WAIT_CID,
        eventData: { resumeAt: waitResumeAt.toISOString() },
      },
      stepCreatedAt
    ),
  ];
}

async function runSuspendedScenario(options: {
  stepCreatedAt: Date;
  waitResumeAt?: Date;
}) {
  const waitResumeAt = options.waitResumeAt;
  const workflowRun: WorkflowRun = {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_quickjs_dispatch_wake',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt: RUN_STARTED_AT,
    createdAt: RUN_STARTED_AT,
    updatedAt: RUN_STARTED_AT,
  };

  const durableEvents = makeLog(
    options.stepCreatedAt,
    waitResumeAt ?? new Date(0)
  ).filter((e) => waitResumeAt !== undefined || e.eventType !== 'wait_created');

  let listCallCount = 0;
  const queued: { options?: Record<string, unknown> }[] = [];

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: vi.fn(async () => {
        listCallCount++;
        return listCallCount === 1
          ? {
              data: [...durableEvents],
              cursor: durableEvents.at(-1)?.eventId ?? null,
              hasMore: false,
            }
          : { data: [], cursor: null, hasMore: false };
      }),
      create: vi.fn(async (_runId: string, request: CreateEventRequest) => ({
        event: { ...request, runId: RUN_ID, eventId: 'evnt_created' },
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn(async (_name: string, _payload: unknown, opts?: unknown) => {
      queued.push({ options: opts as Record<string, unknown> | undefined });
      return { messageId: `msg_${queued.length}` };
    }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  startQuickJSWorkflow.mockResolvedValue({
    result: {
      suspended: {
        pendingOperations: [
          {
            type: 'step',
            correlationId: STEP_CID,
            stepId: 'lostStep',
            // Durable step_created: the dispatch pass leaves this step alone,
            // so its message is already out there.
            hasCreatedEvent: true,
            input: [],
          },
          ...(waitResumeAt
            ? [
                {
                  type: 'wait',
                  correlationId: WAIT_CID,
                  hasCreatedEvent: true,
                  resumeAt: waitResumeAt.toISOString(),
                },
              ]
            : []),
        ],
      },
    },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  });

  const nowMs = Date.now();
  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun,
  });

  const expectedWake = getStepDispatchWake(
    [{ correlationId: STEP_CID, createdEventAt: +options.stepCreatedAt }],
    nowMs
  );
  return { queued, expectedWake };
}

describe('QuickJS suspension arms the re-dispatch watchdog wake', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('arms it for a created-but-unstarted step with nothing else outstanding', async () => {
    const stepCreatedAt = new Date(RUN_STARTED_AT);
    const { queued, expectedWake } = await runSuspendedScenario({
      stepCreatedAt,
    });

    expect(expectedWake).toBeDefined();
    const keys = queued.map((m) => m.options?.idempotencyKey);
    expect(keys).toContain(expectedWake?.idempotencyKey);
  });

  it('arms it alongside a pending wait, whose continuation is far later', async () => {
    const stepCreatedAt = new Date(RUN_STARTED_AT);
    // A wait resuming a day out: the continuation is scheduled, and if the
    // watchdog wake rode on it the step would not be re-evaluated until then.
    const waitResumeAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { queued, expectedWake } = await runSuspendedScenario({
      stepCreatedAt,
      waitResumeAt,
    });

    expect(expectedWake).toBeDefined();
    const wake = queued.find(
      (m) => m.options?.idempotencyKey === expectedWake?.idempotencyKey
    );
    // The wake is armed in the same suspension as the wait continuation, not
    // skipped by it. Both messages, two distinct keys.
    expect(wake).toBeDefined();
    expect(queued.length).toBeGreaterThanOrEqual(2);
    const otherKeys = queued
      .map((m) => m.options?.idempotencyKey)
      .filter((k) => k !== expectedWake?.idempotencyKey);
    expect(otherKeys.length).toBeGreaterThan(0);
    // And it lands at its own boundary, far short of the wait's resume.
    const boundaryMs = nextStepDispatchBoundaryMs(
      { correlationId: STEP_CID, createdEventAt: +stepCreatedAt },
      Date.now()
    );
    expect(boundaryMs).toBeDefined();
    expect((wake?.options?.delaySeconds as number) * 1000).toBeLessThan(
      +waitResumeAt - Date.now()
    );
  });
});
