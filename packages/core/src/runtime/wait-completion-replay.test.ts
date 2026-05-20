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

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

describe('workflow handler wait completion replay', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('reloads events after completing an elapsed wait so hooks received before the wait completion win Promise.race deterministically', async () => {
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
    let capturedHandler:
      | ((
          message: unknown,
          metadata: { queueName: string; messageId: string; attempt: number }
        ) => Promise<unknown>)
      | undefined;

    const listEvents = vi.fn(async () => ({
      data:
        listEvents.mock.calls.length === 1
          ? [...staleEvents]
          : [...durableEvents],
      hasMore: false,
      cursor: null,
    }));

    const createEvent = vi.fn(
      async (_runId: string, request: CreateEventRequest) => {
        if (request.eventType === 'run_started') {
          return { run: workflowRun };
        }

        if (request.eventType === 'wait_completed') {
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
            await drainStep({ index });
            return result.value.value;
          }

          return "sleep";
        } finally {
          hook.dispose();
        }
      }

      ${getWorkflowTransformCode(workflowName)}
    `;

    workflowEntrypoint(workflowCode);
    expect(capturedHandler).toBeDefined();

    await capturedHandler?.(
      { runId },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: 'msg_workflow',
        attempt: 1,
      }
    );

    expect(listEvents).toHaveBeenCalledTimes(2);
    expect(createdEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'wait_completed',
          correlationId: waitCorrelationId,
        }),
        expect.objectContaining({
          eventType: 'step_created',
          eventData: expect.objectContaining({
            stepName: 'drainStep',
          }),
        }),
      ])
    );
    expect(createdEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'step_created',
          eventData: expect.objectContaining({
            stepName: 'syncStep',
          }),
        }),
      ])
    );
  });
});
