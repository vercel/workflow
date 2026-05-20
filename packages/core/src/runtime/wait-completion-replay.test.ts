import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Drives the real workflow queue handler with a fake World so the test can
 * control the storage interleaving that is hard to reproduce with wall-clock
 * timing: the handler sees a stale event snapshot, then completing the elapsed
 * wait races with a hook payload that landed durably first.
 */
async function runStaleWaitReplayScenario(options: {
  includePreloadedCursor: boolean;
  preloadedHasMore?: boolean;
  omitWaitCompletionFromDelta?: boolean;
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
    seed: `${runId}:${workflowName}:${+startedAt}`,
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
      eventId: `evt_${eventIndex.toString().padStart(3, '0')}`,
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

  const listEvents = vi.fn(
    async (params: {
      runId: string;
      pagination?: { cursor?: string; sortOrder?: 'asc' | 'desc' };
    }) => {
      // Cursor reads simulate the optimized delta fetch. Without a cursor, the
      // runtime has fallen back to a full reload from the beginning.
      let data =
        params.pagination?.cursor === staleEventsCursor
          ? durableEvents.slice(staleEvents.length)
          : [...durableEvents];
      if (
        params.pagination?.cursor === staleEventsCursor &&
        options.omitWaitCompletionFromDelta
      ) {
        data = data.filter((event) => event.eventType !== 'wait_completed');
      }
      listedPages.push(data);
      return {
        data,
        hasMore: false,
        cursor: params.pagination?.cursor
          ? (data.at(-1)?.eventId ?? null)
          : staleEventsCursor,
      };
    }
  );

  const createEvent = vi.fn(
    async (_runId: string, request: CreateEventRequest) => {
      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...staleEvents],
          ...(options.includePreloadedCursor
            ? {
                cursor: staleEventsCursor,
                hasMore: options.preloadedHasMore ?? false,
              }
            : {}),
        };
      }

      if (request.eventType === 'wait_completed') {
        // This is the race: the wait-triggered handler is committing
        // wait_completed, but a hook_received event became durable just before
        // that commit. Replay must observe both events in that durable order.
        if (!durableEvents.includes(hookReceivedEvent)) {
          durableEvents.push(hookReceivedEvent);
        }
      }

      const created = event(request);
      durableEvents.push(created);
      createdEvents.push(created);
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

  await capturedHandler?.(
    { runId },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );

  return {
    createdEvents,
    listEvents,
    listedPages,
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
      includePreloadedCursor: true,
    });

    expect(result.listEvents).toHaveBeenCalledTimes(1);
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
      includePreloadedCursor: false,
    });

    expect(result.listEvents).toHaveBeenCalledTimes(1);
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

  it('falls back to a full reload when preloaded events are partial', async () => {
    // A run_started response can return a preloaded page and still say more
    // pages exist. That page is not a complete replay input, so the handler
    // must discard it and load from the beginning before completing waits.
    const result = await runStaleWaitReplayScenario({
      includePreloadedCursor: true,
      preloadedHasMore: true,
    });

    expect(result.listEvents).toHaveBeenCalledTimes(2);
    expect(result.listEvents.mock.calls[0]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: undefined,
      })
    );
    expect(result.listEvents.mock.calls[1]?.[0].pagination).toEqual(
      expect.objectContaining({
        sortOrder: 'asc',
        cursor: result.staleEventsCursor,
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
    ]);
    expect(result.listedPages[1]?.map((event) => event.eventType)).toEqual([
      'hook_received',
      'wait_completed',
    ]);
    expectHookBranchQueued(result);
  });

  it('falls back to a full reload when the cursor delta misses the attempted wait completion', async () => {
    // Defensive path: if the cursor read does not include the wait completion
    // this handler just wrote, the cursor was not a safe replay boundary.
    const result = await runStaleWaitReplayScenario({
      includePreloadedCursor: true,
      omitWaitCompletionFromDelta: true,
    });

    expect(result.listEvents).toHaveBeenCalledTimes(2);
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
});
