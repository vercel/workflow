import assert from 'node:assert/strict';
import {
  type CreateEventRequest,
  type Event,
  type EventResult,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The inline step executor requires the step entity from the step_started
 * response. Reconstruct it from the step_created event so the step body can
 * run to completion.
 */
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

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

/**
 * Drives the real workflow queue handler with a fake World so the test can
 * control the storage interleaving that is hard to reproduce with wall-clock
 * timing: the handler sees a stale event snapshot, then completing the elapsed
 * wait races with a hook payload that landed durably first.
 */
async function runStaleWaitReplayScenario(options: {
  preload: 'legacy' | 'complete' | 'partial' | 'partialWithoutCursor';
  omitWaitCompletionFromDelta?: boolean;
  terminalFailureAfterWaitCompletion?: boolean;
  /**
   * Model a World that honors `sinceCursor` on `events.create`: the write
   * response carries the same page `events.list` would have returned, so the
   * handler should absorb it and skip the follow-up fetch entirely.
   */
  returnInlineDelta?: boolean;
  /** Truncate that inline delta (hasMore: true), which must not be absorbed. */
  inlineDeltaHasMore?: boolean;
}) {
  vi.spyOn(Date, 'now').mockReturnValue(+fixedNow);

  const runId = 'wrun_stale_wait_replay';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_stale_wait_replay';
  const hookToken = 'stale-wait-hook-token';
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
  const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
  const hookCorrelationId = `hook_${ulid(+startedAt)}`;
  const syncStep0CorrelationId = `step_${ulid(+startedAt)}`;
  const waitCorrelationId = `wait_${ulid(+startedAt)}`;

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

  let eventIndex = 0;
  const event = (
    data: CreateEventRequest,
    createdAt = new Date(+startedAt + ++eventIndex * 100)
  ): Event =>
    ({
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(eventIndex),
      createdAt,
    }) as Event;

  const runCreatedEvent = {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId,
      workflowName,
      input: workflowArgs,
    },
  } satisfies CreateEventRequest;

  const staleEvents: Event[] = [
    event(runCreatedEvent),
    event({
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    }),
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
          {
            args: [{ index: 0 }],
            closureVars: undefined,
            thisVal: undefined,
          },
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
      eventData: {
        resumeAt: new Date(+startedAt - 1_000),
      },
    }),
  ];

  const staleEventsCursor = 'cursor-after-stale-events';
  const partialPreload =
    options.preload === 'partial' || options.preload === 'partialWithoutCursor';
  const preloadedEvents = partialPreload
    ? staleEvents.slice(0, 3)
    : staleEvents;
  const lastPreloadedEvent = preloadedEvents.at(-1);
  assert(lastPreloadedEvent);
  const preloadedCursor = partialPreload
    ? lastPreloadedEvent.eventId
    : staleEventsCursor;
  const hookReceivedEvent = event({
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
  });

  const durableEvents = [...staleEvents];
  const createdEvents: Event[] = [];
  const listedPages: Event[][] = [];
  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;

  /**
   * `events.list` semantics for this fake log: everything strictly after
   * `cursor`. `staleEventsCursor` is the opaque cursor the run_started
   * preload hands out; every other cursor is an event id.
   */
  const eventsAfterCursor = (cursor?: string): Event[] => {
    if (!cursor) {
      return [...durableEvents];
    }
    if (cursor === staleEventsCursor) {
      return durableEvents.slice(staleEvents.length);
    }
    const index = durableEvents.findIndex((e) => e.eventId === cursor);
    assert(index >= 0, `Unknown event cursor: ${cursor}`);
    return durableEvents.slice(index + 1);
  };

  const listEvents = vi.fn(
    async (params: {
      runId: string;
      pagination?: { cursor?: string; sortOrder?: 'asc' | 'desc' };
    }) => {
      // Cursor reads simulate the optimized delta fetch. Without a cursor, the
      // runtime has fallen back to a full reload from the beginning.
      const requestedCursor = params.pagination?.cursor;
      let data = eventsAfterCursor(requestedCursor);
      if (
        requestedCursor === staleEventsCursor &&
        options.omitWaitCompletionFromDelta
      ) {
        data = data.filter((event) => event.eventType !== 'wait_completed');
      }
      listedPages.push(data);
      return {
        data,
        hasMore: false,
        cursor: data.at(-1)?.eventId ?? requestedCursor ?? null,
      };
    }
  );

  // Host-side registration for the step the hook branch executes inline.
  // Without it, the V2 inline executor fails the step as unregistered and
  // the scenario degenerates into a run failure instead of a suspension.
  registerStepFunction('drainStep', async () => undefined);

  const runStartedResponse: EventResult = {
    run: workflowRun,
    events: preloadedEvents,
  };
  if (options.preload === 'partialWithoutCursor') {
    runStartedResponse.hasMore = true;
  } else if (options.preload !== 'legacy') {
    runStartedResponse.cursor = preloadedCursor;
    runStartedResponse.hasMore = options.preload === 'partial';
  }

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: { sinceCursor?: string }
    ) => {
      if (request.eventType === 'run_started') {
        return runStartedResponse;
      }

      if (request.eventType === 'wait_completed') {
        // This is the race: the wait-triggered handler is committing
        // wait_completed, but a hook_received event became durable just before
        // that commit. Replay must observe both events in that durable order.
        if (!durableEvents.includes(hookReceivedEvent)) {
          durableEvents.push(hookReceivedEvent);
        }
      }

      // Lazy step start: a step_started carrying input creates the step on the
      // fly. Model the real world by synthesizing the step_created event (so
      // buildStepEntity below — and any replay — observes it) before the
      // step_started is recorded. Strip the input off the persisted
      // step_started row, matching the world's wire contract.
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
      // A World that honors sinceCursor answers the write with the delta the
      // caller would otherwise fetch. Computed after the write is durable, so
      // it includes the event just created.
      const inlineDelta = (() => {
        if (!(options.returnInlineDelta && params?.sinceCursor)) {
          return {};
        }
        const data = eventsAfterCursor(params.sinceCursor);
        return {
          events: data,
          cursor: data.at(-1)?.eventId ?? null,
          hasMore: options.inlineDeltaHasMore ?? false,
        };
      })();
      if (effectiveRequest.eventType === 'step_started') {
        return {
          event: created,
          step: buildStepEntity(
            durableEvents,
            runId,
            effectiveRequest.correlationId
          ),
          ...(lazyStepStart ? { stepCreated: true } : {}),
          ...inlineDelta,
        };
      }
      if (
        request.eventType === 'wait_completed' &&
        options.terminalFailureAfterWaitCompletion
      ) {
        durableEvents.push(
          event({
            eventType: 'run_failed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              error: { message: 'failure recorded while completing wait' },
            },
          })
        );
      }
      return { event: created, ...inlineDelta };
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

  await capturedHandler?.(
    { runId },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );

  return {
    createEvent,
    createdEvents,
    listEvents,
    listedPages,
    queue,
    staleEvents,
    preloadedEvents,
    preloadedCursor,
    staleEventsCursor,
    waitCorrelationId,
  };
}

function expectHookBranchQueued(
  result: Awaited<ReturnType<typeof runStaleWaitReplayScenario>>
) {
  expect(result.createdEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventType: 'wait_completed',
        correlationId: result.waitCorrelationId,
      }),
      expect.objectContaining({
        eventType: 'step_created',
        eventData: expect.objectContaining({
          stepName: 'drainStep',
        }),
      }),
    ])
  );
  expect(result.createdEvents).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventType: 'step_created',
        eventData: expect.objectContaining({
          stepName: 'syncStep',
        }),
      }),
    ])
  );
}

describe('workflow handler wait completion replay', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('loads only events after the preloaded cursor after completing an elapsed wait', async () => {
    // Happy path: run_started gave the handler a complete snapshot and cursor,
    // so after wait_completed it only needs the delta containing the hook and
    // wait completion.
    const result = await runStaleWaitReplayScenario({
      preload: 'complete',
    });

    // The first call is the cursor delta after wait completion; the second
    // is the next loop iteration's incremental fetch after the hook branch's
    // drainStep executed inline.
    expect(result.listEvents).toHaveBeenCalledTimes(2);
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: result.staleEventsCursor,
      })
    );
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'hook_received',
      'wait_completed',
    ]);
    expectHookBranchQueued(result);
  });

  it('falls back to a full reload when preloaded events do not include a cursor', async () => {
    // Backward compatibility path for worlds/servers that return preloaded
    // events but do not yet return pagination metadata with them.
    const result = await runStaleWaitReplayScenario({
      preload: 'legacy',
    });

    // Full reload after wait completion, plus the next loop iteration's
    // incremental fetch after the inline drainStep execution.
    expect(result.listEvents).toHaveBeenCalledTimes(2);
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: undefined,
      })
    );
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
      'step_created',
      'step_started',
      'step_completed',
      'wait_created',
      'hook_received',
      'wait_completed',
    ]);
    expectHookBranchQueued(result);
  });

  it('continues a partial preload from its cursor without rereading the prefix', async () => {
    // A run_started response can return a first page and report that more pages
    // exist. The runtime must retain that prefix and load only its suffix.
    const result = await runStaleWaitReplayScenario({
      preload: 'partial',
    });

    // Partial-preload continuation, cursor delta after wait completion, then
    // the next loop iteration's incremental fetch after the inline drainStep.
    expect(result.listEvents).toHaveBeenCalledTimes(3);
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual({
      sortOrder: 'asc',
      cursor: result.preloadedCursor,
    });
    expect(
      result.listEvents.mock.calls.every(
        ([params]) => params.pagination?.cursor !== undefined
      )
    ).toBe(true);
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
      'wait_created',
    ]);
    expect(result.listedPages[1]?.map((event) => event.eventType)).toEqual([
      'hook_received',
      'wait_completed',
    ]);
    expect(
      result.listedPages
        .flat()
        .filter((listed) =>
          result.preloadedEvents.some(
            (preloaded) => preloaded.eventId === listed.eventId
          )
        )
        .map((event) => event.eventType)
    ).toEqual([]);
    expectHookBranchQueued(result);
  });

  it('falls back to a full reload when a partial preload omits its cursor', async () => {
    const result = await runStaleWaitReplayScenario({
      preload: 'partialWithoutCursor',
    });

    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual({
      sortOrder: 'asc',
      cursor: undefined,
    });
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
      'step_created',
      'step_started',
      'step_completed',
      'wait_created',
    ]);
    expectHookBranchQueued(result);
  });

  it('falls back to a full reload when the cursor delta misses the attempted wait completion', async () => {
    // Defensive path: if the cursor read does not include the wait completion
    // this handler just wrote, the cursor was not a safe replay boundary.
    const result = await runStaleWaitReplayScenario({
      preload: 'complete',
      omitWaitCompletionFromDelta: true,
    });

    // Cursor delta (missing the wait completion), full-reload fallback,
    // then the next loop iteration's incremental fetch after the inline
    // drainStep execution.
    expect(result.listEvents).toHaveBeenCalledTimes(3);
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: result.staleEventsCursor,
      })
    );
    expect(result.listEvents.mock.calls[1]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: undefined,
      })
    );
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'hook_received',
    ]);
    expect(result.listedPages[1]?.map((event) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
      'step_created',
      'step_started',
      'step_completed',
      'wait_created',
      'hook_received',
      'wait_completed',
    ]);
    expectHookBranchQueued(result);
  });

  it('skips the follow-up fetch when the wait_completed write returns the delta', async () => {
    // The write carries the cursor the handler's snapshot was taken at, so a
    // supporting World answers it with exactly the page the follow-up
    // events.list would have returned. Absorbing that page leaves nothing to
    // fetch: the hook_received that raced the completion is already in the
    // local log.
    const result = await runStaleWaitReplayScenario({
      preload: 'complete',
      returnInlineDelta: true,
    });

    const waitWrite = result.createEvent.mock.calls.find(
      (call) => (call[1] as CreateEventRequest).eventType === 'wait_completed'
    );
    expect(waitWrite?.[2]).toEqual(
      expect.objectContaining({ sinceCursor: result.staleEventsCursor })
    );

    // Only the next loop iteration's incremental fetch remains, and it reads
    // from the cursor the absorbed delta advanced to — never from the
    // pre-write cursor, which is what the deleted follow-up fetch used.
    expect(result.listEvents).toHaveBeenCalledTimes(1);
    expect(result.listEvents.mock.calls[0]?.[0].pagination?.cursor).not.toBe(
      result.staleEventsCursor
    );
    expectHookBranchQueued(result);
  });

  it('asks for the delta and the skipped slots at once', async () => {
    // The write carries both halves of the World's answer channel: `sinceCursor` asks for the delta since the handler's
    // snapshot, and `eventCount` states the slot that snapshot reached so a
    // bumped write can report what it was decided without. They share
    // `events`/`cursor`/`hasMore` on the response, so a World that answers
    // both has to pick one, and the delta is the superset. Anything narrower
    // returned alongside the delta's cursor loses the difference.
    const result = await runStaleWaitReplayScenario({
      includePreloadedCursor: true,
      returnInlineDelta: true,
    });

    const waitWrite = result.createEvent.mock.calls.find(
      (call) => (call[1] as CreateEventRequest).eventType === 'wait_completed'
    );
    expect(waitWrite?.[2]).toEqual(
      expect.objectContaining({
        sinceCursor: result.staleEventsCursor,
        eventCount: result.staleEvents.length,
      })
    );
    expectHookBranchQueued(result);
  });

  it('falls back to the follow-up fetch when the returned delta is truncated', async () => {
    // hasMore means the page is not the whole delta. Absorbing it would leave
    // a hole between the events taken and the cursor reported, so the handler
    // must decline it and fetch as before.
    const result = await runStaleWaitReplayScenario({
      preload: 'complete',
      returnInlineDelta: true,
      inlineDeltaHasMore: true,
    });

    expect(result.listEvents).toHaveBeenCalledTimes(2);
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: result.staleEventsCursor,
      })
    );
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'hook_received',
      'wait_completed',
    ]);
    expectHookBranchQueued(result);
  });

  it('stops after wait refresh when the event log contains a terminal run event', async () => {
    const result = await runStaleWaitReplayScenario({
      preload: 'complete',
      terminalFailureAfterWaitCompletion: true,
    });

    expect(result.listEvents).toHaveBeenCalledTimes(1);
    expect(result.listedPages[0]?.map((event) => event.eventType)).toEqual([
      'hook_received',
      'wait_completed',
      'run_failed',
    ]);
    expect(result.createdEvents).toEqual([
      expect.objectContaining({
        eventType: 'wait_completed',
        correlationId: result.waitCorrelationId,
      }),
    ]);
    expect(result.queue).not.toHaveBeenCalled();
  });
});
