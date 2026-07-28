/**
 * Drives the real workflowEntrypoint replay loop (not just the helpers) to
 * validate the stateUpdatedAt precondition guard end to end on the client:
 *
 * 1. A wait_completed create is rejected as stale (412) because a hook landed
 *    out-of-band after the snapshot. The runtime must reload the event log
 *    from its cursor, retry the create with the *newer* stateUpdatedAt, and
 *    the replay must then observe the hook branch.
 * 2. A run_completed create rejected as stale must NOT be retried in place
 *    (the stale result must not be re-committed) — the error propagates to
 *    the queue handler and the run is not failed.
 *
 * Modeled on wait-completion-replay.test.ts, but with real ULID event IDs so
 * latestEventStateUpdatedAt() actually derives snapshot times.
 */
import { PreconditionFailedError } from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { createContext } from '../vm/index.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const fixedNow = new Date('2026-05-19T12:00:20.000Z');

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

function buildStepEntity(
  durableEvents: Event[],
  runId: string,
  correlationId: string | undefined
) {
  const stepCreated = durableEvents.find(
    (e) => e.eventType === 'step_created' && e.correlationId === correlationId
  );
  const stepCreatedData = stepCreated?.eventData as
    | { stepName?: string; input?: unknown }
    | undefined;
  return {
    runId,
    stepId: correlationId,
    stepName: stepCreatedData?.stepName,
    status: 'running',
    attempt: 1,
    input: stepCreatedData?.input,
    startedAt: fixedNow,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

async function runPreconditionScenario(options: {
  /** Reject the first wait_completed create with 412 (hook landed). */
  rejectWaitCompletedOnce?: boolean;
}) {
  vi.spyOn(Date, 'now').mockReturnValue(+fixedNow);

  const runId = 'wrun_precondition_guard_replay';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_precondition_guard_replay';
  const hookToken = 'precondition-hook-token';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowArgs = await dehydrateWorkflowArguments(
    [hookToken],
    runId,
    undefined
  );

  const { globalThis: vmGlobalThis } = createContext({
    seed: `${runId}:${workflowName}:${deploymentId}`,
    fixedTimestamp: +startedAt,
  });
  const vmUlid = monotonicFactory(() => vmGlobalThis.Math.random());
  const hookCorrelationId = `hook_${vmUlid(+startedAt)}`;
  const syncStep0CorrelationId = `step_${vmUlid(+startedAt)}`;
  const waitCorrelationId = `wait_${vmUlid(+startedAt)}`;

  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: workflowArgs,
    deploymentId,
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  // Real ULID event IDs at controlled times so latestEventStateUpdatedAt()
  // resolves an actual epoch-ms snapshot from the loaded log.
  const hostUlid = monotonicFactory();
  let eventIndex = 0;
  const event = (data: CreateEventRequest, atMs?: number): Event => {
    const t = atMs ?? +startedAt + ++eventIndex * 100;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: `evnt_${hostUlid(t)}`,
      createdAt: new Date(t),
    } as Event;
  };

  const staleEvents: Event[] = [
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    }),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }),
    event({
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: hookCorrelationId,
      eventData: { token: hookToken },
    }),
    event({
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: syncStep0CorrelationId,
      eventData: {
        stepName: 'syncStep',
        input: await dehydrateStepArguments(
          { args: [{ index: 0 }], closureVars: undefined, thisVal: undefined },
          runId,
          undefined
        ),
      },
    }),
    event({
      eventType: 'step_started',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: syncStep0CorrelationId,
    }),
    event({
      eventType: 'step_completed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: syncStep0CorrelationId,
      eventData: {
        result: await dehydrateStepReturnValue(undefined, runId, undefined),
      },
    }),
    event({
      eventType: 'wait_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: waitCorrelationId,
      eventData: { resumeAt: new Date(+startedAt - 1_000) },
    }),
  ];
  const staleSnapshotMs = +startedAt + staleEvents.length * 100;
  expect(staleSnapshotMs).toBe(+startedAt + 700);

  const staleEventsCursor = 'cursor-after-stale-events';
  const OUTSIDE_EVENT_MS = +startedAt + 5_000;
  const hookReceivedEvent = event(
    {
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: hookCorrelationId,
      eventData: {
        payload: await dehydrateStepReturnValue(
          { value: 'hook-wins' },
          runId,
          undefined
        ),
      },
    },
    OUTSIDE_EVENT_MS
  );

  const durableEvents = [...staleEvents];
  const createdEvents: Event[] = [];
  const createParams: Array<{
    eventType: string;
    stateUpdatedAt: number | undefined;
  }> = [];
  let waitCompletedRejections = 0;
  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;

  const listEvents = vi.fn(
    async (params: {
      runId: string;
      pagination?: { cursor?: string; sortOrder?: 'asc' | 'desc' };
    }) => {
      const data =
        params.pagination?.cursor === staleEventsCursor
          ? durableEvents.slice(staleEvents.length)
          : [...durableEvents];
      return {
        data,
        hasMore: false,
        cursor: params.pagination?.cursor
          ? (data.at(-1)?.eventId ?? null)
          : staleEventsCursor,
      };
    }
  );

  registerStepFunction('drainStep', async () => undefined);

  const runStartedResponse = {
    run: workflowRun,
    events: [...staleEvents],
    cursor: staleEventsCursor,
    hasMore: false,
  };

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: { stateUpdatedAt?: number }
    ) => {
      createParams.push({
        eventType: request.eventType,
        stateUpdatedAt: params?.stateUpdatedAt,
      });

      if (request.eventType === 'run_started') {
        return runStartedResponse;
      }

      if (request.eventType === 'wait_completed') {
        // The out-of-band hook payload becomes durable just before the
        // wait_completed commit — this is the exact race the guard closes.
        if (!durableEvents.includes(hookReceivedEvent)) {
          durableEvents.push(hookReceivedEvent);
        }
        if (
          options.rejectWaitCompletedOnce &&
          waitCompletedRejections === 0 &&
          (params?.stateUpdatedAt ?? 0) < OUTSIDE_EVENT_MS
        ) {
          waitCompletedRejections++;
          throw new PreconditionFailedError(
            'Run state is stale: an out-of-band event was recorded after the client snapshot.'
          );
        }
      }

      // Lazy step start: synthesize step_created like the real world does.
      const lazyStepStart =
        request.eventType === 'step_started' &&
        !!request.eventData &&
        (request.eventData as { input?: unknown }).input !== undefined;
      let effectiveRequest = request;
      if (lazyStepStart) {
        const lazyData = request.eventData as {
          stepName?: string;
          input?: unknown;
        };
        const syntheticStepCreated = event({
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: request.correlationId,
          eventData: { stepName: lazyData.stepName, input: lazyData.input },
        } as CreateEventRequest);
        durableEvents.push(syntheticStepCreated);
        createdEvents.push(syntheticStepCreated);
        const { input: _strippedInput, ...startEventData } = lazyData;
        effectiveRequest = {
          ...request,
          eventData: startEventData,
        } as CreateEventRequest;
      }

      const created = event(effectiveRequest);
      durableEvents.push(created);
      createdEvents.push(created);
      if (effectiveRequest.eventType === 'step_started') {
        return {
          event: created,
          step: buildStepEntity(
            durableEvents,
            runId,
            effectiveRequest.correlationId
          ),
          ...(lazyStepStart ? { stepCreated: true } : {}),
        };
      }
      return { event: created };
    }
  );

  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_step' });
  const fakeWorld = {
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: {
      list: listEvents,
      create: createEvent,
    },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;

  setWorld(fakeWorld);

  const workflowCode = `
    const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
    const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    const syncStep = useStep("syncStep");
    const drainStep = useStep("drainStep");

    async function workflow(token) {
      const hook = createHook({ token });
      const iterator = hook[Symbol.asyncIterator]();
      let pendingRead;

      try {
        for (let index = 0; index < 2; index += 1) {
          await syncStep({ index });
          pendingRead ??= iterator.next();
          const result = await Promise.race([
            pendingRead.then((value) => ({ kind: "hook", value })),
            sleep("5s").then(() => ({ kind: "sleep" })),
          ]);

          if (result.kind === "sleep") {
            continue;
          }

          pendingRead = undefined;
          await Promise.all([drainStep({ index }), sleep("1h")]);
          return result.value.value;
        }

        return "sleep";
      } finally {
        hook.dispose();
      }
    }

    ${getWorkflowTransformCode(workflowName)}
  `;

  const handler = workflowEntrypoint(workflowCode);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  const handlerInvocation = capturedHandler?.(
    { runId },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );

  return {
    handlerInvocation,
    createdEvents,
    createParams,
    listEvents,
    queue,
    staleEventsCursor,
    staleSnapshotMs,
    OUTSIDE_EVENT_MS,
    waitCorrelationId,
    waitCompletedRejectionCount: () => waitCompletedRejections,
  };
}

/**
 * Minimal scenario for the run_completed path: a workflow that immediately
 * returns, replayed from a loaded 2-event log, with every run_completed
 * create rejected as stale (412).
 */
async function runCompletedRejectionScenario() {
  vi.spyOn(Date, 'now').mockReturnValue(+fixedNow);

  const runId = 'wrun_precondition_run_completed';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_precondition_run_completed';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowArgs = await dehydrateWorkflowArguments([], runId, undefined);

  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: workflowArgs,
    deploymentId,
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  const hostUlid = monotonicFactory();
  let eventIndex = 0;
  const event = (data: CreateEventRequest, atMs?: number): Event => {
    const t = atMs ?? +startedAt + ++eventIndex * 100;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: `evnt_${hostUlid(t)}`,
      createdAt: new Date(t),
    } as Event;
  };

  const staleEvents: Event[] = [
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    }),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }),
  ];
  const staleEventsCursor = 'cursor-after-stale-events';

  const createParams: Array<{
    eventType: string;
    stateUpdatedAt: number | undefined;
  }> = [];
  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;

  const listEvents = vi.fn(async () => ({
    data: [...staleEvents],
    hasMore: false,
    cursor: staleEventsCursor,
  }));

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: { stateUpdatedAt?: number }
    ) => {
      createParams.push({
        eventType: request.eventType,
        stateUpdatedAt: params?.stateUpdatedAt,
      });
      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...staleEvents],
          cursor: staleEventsCursor,
          hasMore: false,
        };
      }
      if (request.eventType === 'run_completed') {
        throw new PreconditionFailedError(
          'Run state is stale: an out-of-band event was recorded after the client snapshot.'
        );
      }
      return { event: event(request) };
    }
  );

  const fakeWorld = {
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: {
      list: listEvents,
      create: createEvent,
    },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_step' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;

  setWorld(fakeWorld);

  const workflowCode = `
    async function workflow() {
      return "done";
    }

    ${getWorkflowTransformCode(workflowName)}
  `;

  const handler = workflowEntrypoint(workflowCode);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  const handlerInvocation = capturedHandler?.(
    { runId },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );

  return {
    handlerInvocation,
    createParams,
    runStartedSnapshotMs: +startedAt + 200,
  };
}

describe('precondition guard through the real replay loop', () => {
  let originalGuard: string | undefined;

  beforeEach(() => {
    originalGuard = process.env.WORKFLOW_PRECONDITION_GUARD;
    // The guard is opt-in; these scenarios exercise the opted-in path.
    process.env.WORKFLOW_PRECONDITION_GUARD = '1';
  });

  afterEach(() => {
    if (originalGuard !== undefined) {
      process.env.WORKFLOW_PRECONDITION_GUARD = originalGuard;
    } else {
      delete process.env.WORKFLOW_PRECONDITION_GUARD;
    }
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('reloads and retries a 412-rejected wait_completed with the newer snapshot, then takes the hook branch', async () => {
    const result = await runPreconditionScenario({
      rejectWaitCompletedOnce: true,
    });
    await result.handlerInvocation;

    // Rejected once, then retried and accepted.
    expect(result.waitCompletedRejectionCount()).toBe(1);
    const waitCreates = result.createParams.filter(
      (c) => c.eventType === 'wait_completed'
    );
    expect(waitCreates).toHaveLength(2);
    // First attempt carried the stale snapshot (ULID time of wait_created)...
    expect(waitCreates[0]?.stateUpdatedAt).toBe(result.staleSnapshotMs);
    // ...the retry carried the reloaded snapshot (ULID time of hook_received).
    expect(waitCreates[1]?.stateUpdatedAt).toBe(result.OUTSIDE_EVENT_MS);

    // The guard reloaded from the held cursor (not a full re-list).
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: result.staleEventsCursor,
      })
    );

    // Replay after the retry observed the hook and took the hook branch.
    expect(result.createdEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'wait_completed',
          correlationId: result.waitCorrelationId,
        }),
        expect.objectContaining({
          eventType: 'step_created',
          eventData: expect.objectContaining({ stepName: 'drainStep' }),
        }),
      ])
    );
  });

  it('does not retry a 412-rejected run_completed in place; it schedules an immediate re-invocation and the run is not failed', async () => {
    const result = await runCompletedRejectionScenario();

    // The handler must NOT throw (the turbo path has already acked the
    // message, so a rethrow would strand the run until the queue's ~300s
    // default visibility timeout). It resolves with an immediate re-invoke
    // so a fresh replay observes the new event.
    await expect(result.handlerInvocation).resolves.toEqual({
      timeoutSeconds: 0,
    });

    // The stale result must not be re-committed: exactly one attempt, carrying
    // the loaded snapshot (ULID time of run_started).
    const runCompletedCreates = result.createParams.filter(
      (c) => c.eventType === 'run_completed'
    );
    expect(runCompletedCreates).toHaveLength(1);
    expect(runCompletedCreates[0]?.stateUpdatedAt).toBe(
      result.runStartedSnapshotMs
    );
    // And the runtime must not convert the rejection into a run failure.
    expect(
      result.createParams.filter((c) => c.eventType === 'run_failed')
    ).toHaveLength(0);
  });
});
