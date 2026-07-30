/**
 * Drives the real workflowEntrypoint replay loop (not just the helpers) to
 * validate the precondition guard end to end on the client:
 *
 * 1. A create rejected as stale (412) because another writer landed an event
 *    after the snapshot must restart the replay *in this invocation* — never
 *    re-post the rejected payload. The payload's correlation ids were minted
 *    by the rejected replay's seeded ULID sequence, so a corrected event log
 *    generally implies different ids; only a fresh replay may write again.
 * 2. The restart reloads the whole event log with no cursor, because a hole is
 *    defined by ULID time while a cursor filters lexicographically — unless
 *    the World attached the missing events to the 412, which the runtime
 *    consumes with no events.list round trip at all (first restart only).
 * 3. Restarts are bounded; once the bound is spent the runtime schedules one
 *    immediate re-invocation instead of failing the run.
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
import { getPreconditionMaxInProcessRestarts } from './constants.js';
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

interface SnapshotParams {
  eventType: string;
  stateUpdatedAt: number | undefined;
  stateEventCount: number | undefined;
  stateCursor: string | undefined;
}

async function runPreconditionScenario(options: {
  /** How many wait_completed creates to reject with 412 (hook landed). */
  rejectWaitCompletedTimes?: number;
  /**
   * What a rejecting World attaches to the 412: the missing event (`complete`),
   * or a payload the runtime must refuse to narrow (`malformed`).
   */
  attachDelta?: 'complete' | 'malformed';
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
  const createParams: SnapshotParams[] = [];
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
      params?: {
        stateUpdatedAt?: number;
        stateEventCount?: number;
        stateCursor?: string;
      }
    ) => {
      createParams.push({
        eventType: request.eventType,
        stateUpdatedAt: params?.stateUpdatedAt,
        stateEventCount: params?.stateEventCount,
        stateCursor: params?.stateCursor,
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
        if (waitCompletedRejections < (options.rejectWaitCompletedTimes ?? 0)) {
          waitCompletedRejections++;
          throw new PreconditionFailedError(
            'Run state is stale: the client event log is missing at least one event at or before its snapshot.',
            options.attachDelta === undefined
              ? undefined
              : {
                  details:
                    options.attachDelta === 'complete'
                      ? { events: [hookReceivedEvent], cursor: 'cursor-412' }
                      : { events: [{ notAnEvent: true }] },
                }
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

  const createParams: SnapshotParams[] = [];
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
      params?: {
        stateUpdatedAt?: number;
        stateEventCount?: number;
        stateCursor?: string;
      }
    ) => {
      createParams.push({
        eventType: request.eventType,
        stateUpdatedAt: params?.stateUpdatedAt,
        stateEventCount: params?.stateEventCount,
        stateCursor: params?.stateCursor,
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
    listEvents,
    staleEventCount: staleEvents.length,
    staleEventsCursor,
    runStartedSnapshotMs: +startedAt + 200,
  };
}

/**
 * Minimal scenario for the attribute path: a workflow that sets an attribute
 * and returns. The attr_set a suspension writes is guarded like every other
 * replay-origin write, so it must carry the snapshot.
 */
async function attributeSnapshotScenario() {
  vi.spyOn(Date, 'now').mockReturnValue(+fixedNow);

  const runId = 'wrun_precondition_attr_set';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_precondition_attr_set';
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
  const durableEvents: Event[] = [];
  const event = (data: CreateEventRequest): Event =>
    ({
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: `evnt_${hostUlid(+startedAt + ++eventIndex * 100)}`,
      createdAt: new Date(+startedAt + eventIndex * 100),
    }) as Event;

  durableEvents.push(
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    }),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT })
  );
  const preloadedCursor = 'cursor-after-run-started';

  const createParams: SnapshotParams[] = [];
  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: {
        stateUpdatedAt?: number;
        stateEventCount?: number;
        stateCursor?: string;
      }
    ) => {
      createParams.push({
        eventType: request.eventType,
        stateUpdatedAt: params?.stateUpdatedAt,
        stateEventCount: params?.stateEventCount,
        stateCursor: params?.stateCursor,
      });
      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...durableEvents],
          cursor: preloadedCursor,
          hasMore: false,
        };
      }
      const created = event(request);
      durableEvents.push(created);
      return { event: created };
    }
  );

  const fakeWorld = {
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: {
      list: vi.fn(async () => ({
        data: [...durableEvents],
        hasMore: false,
        cursor: preloadedCursor,
      })),
      create: createEvent,
    },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_step' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;

  setWorld(fakeWorld);

  const workflowCode = `
    const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];

    async function workflow() {
      await setAttributes([{ key: "tenant", value: "acme" }]);
      return "done";
    }

    ${getWorkflowTransformCode(workflowName)}
  `;

  const handler = workflowEntrypoint(workflowCode);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  await capturedHandler?.(
    { runId },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );

  return { createParams, preloadedCursor };
}

describe('precondition guard through the real replay loop', () => {
  let originalGuard: string | undefined;
  let originalRestartBound: string | undefined;

  beforeEach(() => {
    originalGuard = process.env.WORKFLOW_PRECONDITION_GUARD;
    originalRestartBound =
      process.env.WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS;
    process.env.WORKFLOW_PRECONDITION_GUARD = '1';
  });

  afterEach(() => {
    for (const [name, value] of [
      ['WORKFLOW_PRECONDITION_GUARD', originalGuard],
      ['WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS', originalRestartBound],
    ] as const) {
      if (value !== undefined) {
        process.env[name] = value;
      } else {
        delete process.env[name];
      }
    }
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  /** Only a restart reloads with no cursor; every other load is incremental. */
  const cursorlessLoads = (listEvents: { mock: { calls: unknown[][] } }) =>
    listEvents.mock.calls.filter(
      (call) =>
        !(call[0] as { pagination?: { cursor?: string } }).pagination?.cursor
    ).length;

  it('restarts the replay in-process on a 412, reloading the whole log with no cursor, and then takes the hook branch', async () => {
    const result = await runPreconditionScenario({
      rejectWaitCompletedTimes: 1,
    });
    await result.handlerInvocation;

    expect(result.waitCompletedRejectionCount()).toBe(1);
    const waitCreates = result.createParams.filter(
      (c) => c.eventType === 'wait_completed'
    );
    expect(waitCreates).toHaveLength(2);
    // First attempt carried the stale snapshot (ULID time of wait_created)...
    expect(waitCreates[0]?.stateUpdatedAt).toBe(result.staleSnapshotMs);
    // ...the restarted replay carried the corrected one (ULID time of
    // hook_received), with a count covering the event it had been missing.
    expect(waitCreates[1]?.stateUpdatedAt).toBe(result.OUTSIDE_EVENT_MS);
    expect(waitCreates[1]?.stateEventCount).toBe(
      (waitCreates[0]?.stateEventCount ?? 0) + 1
    );

    // The restart reloaded the full log rather than reading from the held
    // cursor: an `eid:` cursor filters lexicographically, so a hole defined by
    // ULID time can sort below it and survive an incremental load.
    expect(cursorlessLoads(result.listEvents)).toBe(1);

    // Replay after the restart observed the hook and took the hook branch.
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

  it('costs no extra queue message: the restart happens inside the same delivery', async () => {
    // The whole point of restarting in-process rather than re-invoking: a 412
    // mid-replay must not add a queue round trip. Compared against the same
    // scenario without the rejection, since the workflow's own suspension
    // continuations also use the workflow queue.
    const rejected = await runPreconditionScenario({
      rejectWaitCompletedTimes: 1,
    });
    await rejected.handlerInvocation;
    const baseline = await runPreconditionScenario({});
    await baseline.handlerInvocation;

    expect(rejected.waitCompletedRejectionCount()).toBe(1);
    expect(baseline.waitCompletedRejectionCount()).toBe(0);
    expect(rejected.queue.mock.calls).toHaveLength(
      baseline.queue.mock.calls.length
    );
  });

  it('consumes the events a World attaches to the 412 with no events.list round trip', async () => {
    const result = await runPreconditionScenario({
      rejectWaitCompletedTimes: 1,
      attachDelta: 'complete',
    });
    await result.handlerInvocation;

    expect(cursorlessLoads(result.listEvents)).toBe(0);
    const waitCreates = result.createParams.filter(
      (c) => c.eventType === 'wait_completed'
    );
    expect(waitCreates).toHaveLength(2);
    expect(waitCreates[1]?.stateUpdatedAt).toBe(result.OUTSIDE_EVENT_MS);
    expect(result.createdEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'step_created',
          eventData: expect.objectContaining({ stepName: 'drainStep' }),
        }),
      ])
    );
  });

  it('falls back to the full reload when the 412 payload does not narrow to events', async () => {
    const result = await runPreconditionScenario({
      rejectWaitCompletedTimes: 1,
      attachDelta: 'malformed',
    });
    await result.handlerInvocation;

    // Untrusted-shaped data on a failure path: dropped without throwing.
    expect(cursorlessLoads(result.listEvents)).toBe(1);
    expect(
      result.createParams.filter((c) => c.eventType === 'wait_completed')
    ).toHaveLength(2);
  });

  it('trusts an attached delta only on the first restart of an invocation', async () => {
    const result = await runPreconditionScenario({
      rejectWaitCompletedTimes: 2,
      attachDelta: 'complete',
    });
    await result.handlerInvocation;

    // The delta's completeness proof leans on the rejecting World's own index,
    // so a second rejection for the same run means that proof is not to be
    // trusted again — the second restart does the authoritative full reload.
    expect(result.waitCompletedRejectionCount()).toBe(2);
    expect(cursorlessLoads(result.listEvents)).toBe(1);
  });

  it('bounds in-process restarts, then schedules a single immediate re-invocation instead of failing the run', async () => {
    const result = await runCompletedRejectionScenario();

    // The handler must NOT throw (the turbo path has already acked the
    // message, so a rethrow would strand the run until the queue's ~300s
    // default visibility timeout). It resolves with an immediate re-invoke
    // so a fresh invocation replays against a full reload.
    await expect(result.handlerInvocation).resolves.toEqual({
      timeoutSeconds: 0,
    });

    // One attempt per replay: the original plus one per in-process restart.
    // The stale result is never re-posted — each attempt is a fresh replay.
    const runCompletedCreates = result.createParams.filter(
      (c) => c.eventType === 'run_completed'
    );
    expect(runCompletedCreates).toHaveLength(
      1 + getPreconditionMaxInProcessRestarts()
    );
    for (const create of runCompletedCreates) {
      expect(create.stateUpdatedAt).toBe(result.runStartedSnapshotMs);
      expect(create.stateEventCount).toBe(result.staleEventCount);
    }
    // And the runtime must not convert the rejection into a run failure.
    expect(
      result.createParams.filter((c) => c.eventType === 'run_failed')
    ).toHaveLength(0);
  });

  it('honours the restart bound override', async () => {
    process.env.WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS = '1';
    const result = await runCompletedRejectionScenario();

    await expect(result.handlerInvocation).resolves.toEqual({
      timeoutSeconds: 0,
    });
    expect(
      result.createParams.filter((c) => c.eventType === 'run_completed')
    ).toHaveLength(1 + getPreconditionMaxInProcessRestarts());
  });

  it('guards the attr_set a suspension writes with the same snapshot as every other replay-origin write', async () => {
    const result = await attributeSnapshotScenario();

    const attrCreate = result.createParams.find(
      (c) => c.eventType === 'attr_set'
    );
    expect(attrCreate).toBeDefined();
    expect(attrCreate?.stateUpdatedAt).toBeTypeOf('number');
    expect(attrCreate?.stateEventCount).toBe(2);
    expect(attrCreate?.stateCursor).toBe(result.preloadedCursor);
  });
});
