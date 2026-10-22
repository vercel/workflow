/**
 * When a wide `Promise.all` fan-out's queued branches become startable, driven
 * through one real `workflowEntrypoint` delivery.
 *
 * A 64-branch fan-out suspends with 64 pending steps. The first
 * `getMaxInlineSteps()` (3) run inline in this delivery off the pre-claimed
 * pair chunk; the other 61 are created by plain `createBatch` chunks and each
 * chunk's queue messages are published once that chunk commits. The fake
 * World's `createBatch` and `queueBatch` take longer the more events or
 * messages they carry, the shape production shows, so the time until the
 * last queued branch's message is out depends on how the plain creates are
 * chunked (MAX_BATCH_FANOUT_EVENTS).
 */
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type SpecVersion,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Size-scaled latencies: a 32-row chunk costs 170 ms, a 16-row one 90 ms. */
const createBatchMs = (events: number) => 10 + 5 * events;
/** A 32-message publish costs 160 ms, a 16-message one 80 ms. */
const queueBatchMs = (messages: number) => 5 * messages;
const BRANCHES = 64;
const INLINE = 3;

/**
 * Inline bodies hold until the test lets them go, so the test can see what
 * was dispatched while they were still running.
 */
let releaseInlineBodies!: () => void;
let inlineBodiesReleased = new Promise<void>((resolve) => {
  releaseInlineBodies = resolve;
});
const inlineBodiesStarted: number[] = [];
registerStepFunction('fanoutDispatchStep', async () => {
  inlineBodiesStarted.push(Date.now());
  await inlineBodiesReleased;
  return 1;
});

async function runFanout(specVersion: SpecVersion) {
  const runId = `wrun_fanout_dispatch_${specVersion}_${Date.now()}`;
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    specVersion,
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
  let seq = 1;
  const durable: Event[] = [
    {
      eventId: slotToEventId(seq),
      runId,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      eventType: 'run_created',
      specVersion,
      eventData: {
        deploymentId: 'test-deployment',
        workflowName: 'workflow',
        input: workflowRun.input,
      },
    } as unknown as Event,
  ];
  const record = (data: any): Event => {
    seq += 1;
    const event = {
      eventId: slotToEventId(seq),
      runId,
      createdAt: new Date(),
      ...data,
    } as Event;
    durable.push(event);
    return event;
  };
  const inputs = new Map<string, unknown>();
  const started = (stepId: string, stepName?: string) => ({
    runId,
    stepId,
    stepName,
    status: 'running' as const,
    attempt: 1,
    input: inputs.get(stepId),
    startedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const batchSizes: number[] = [];
  let firstBatchPostAt: number | undefined;
  /** When each queued branch's step message was published. */
  const stepPublishedAt = new Map<string, number>();

  let handler!: (message: unknown, metadata: unknown) => Promise<unknown>;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix: string, h: typeof handler) => {
      handler = h;
      return async () => new Response(null, { status: 204 });
    }),
    events: {
      create: vi.fn(async (_runId: string, data: any) => {
        if (data.eventType === 'run_started') {
          return { run: workflowRun, events: [...durable] };
        }
        if (data.eventType === 'step_created') {
          inputs.set(data.correlationId, data.eventData?.input);
        }
        if (data.eventType === 'step_started') {
          return {
            event: record(data),
            step: started(data.correlationId, data.eventData?.stepName),
          };
        }
        return { event: record(data) };
      }),
      createBatch: vi.fn(async (_runId: string, events: any[]) => {
        firstBatchPostAt ??= Date.now();
        batchSizes.push(events.length);
        await sleep(createBatchMs(events.length));
        return {
          results: events.map(({ event }) => {
            if (event.eventType === 'step_created') {
              inputs.set(event.correlationId, event.eventData?.input);
            }
            return {
              status: 200,
              event: record(event),
              ...(event.eventType === 'step_started'
                ? {
                    step: started(
                      event.correlationId,
                      event.eventData?.stepName
                    ),
                  }
                : {}),
            };
          }),
        };
      }),
      list: vi.fn(async () => ({
        data: [...durable],
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn(async (_queueName: string, message: any) => {
      await sleep(queueBatchMs(1));
      if (message.stepId && !stepPublishedAt.has(message.stepId)) {
        stepPublishedAt.set(message.stepId, Date.now());
      }
      return { messageId: null };
    }),
    queueBatch: vi.fn(async (_queueName: string, messages: any[]) => {
      await sleep(queueBatchMs(messages.length));
      for (const { message } of messages) {
        if (message.stepId && !stepPublishedAt.has(message.stepId)) {
          stepPublishedAt.set(message.stepId, Date.now());
        }
      }
      return messages.map(() => ({ messageId: null }));
    }),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const entry = workflowEntrypoint(`
    const fanoutDispatchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fanoutDispatchStep");
    async function workflow() {
      const results = await Promise.all(
        Array.from({ length: ${BRANCHES} }, () => fanoutDispatchStep())
      );
      return results.length;
    };globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`);
  await entry(new Request('https://example.test'));
  const delivery = handler(
    { runId, requestedAt: new Date() },
    {
      requestId: 'req_1',
      attempt: 1,
      queueName: '__wkf_workflow_workflow',
      messageId: 'msg_flow_1',
    }
  );

  // Every queued branch's message must go out while the inline bodies are
  // still running: their dispatch never waits on inline step execution.
  const deadline = Date.now() + 5_000;
  while (stepPublishedAt.size < BRANCHES - INLINE && Date.now() < deadline) {
    await sleep(5);
  }
  const allQueuedPublishedWhileInlineRan =
    stepPublishedAt.size === BRANCHES - INLINE;
  releaseInlineBodies();
  await delivery;

  return {
    batchSizes,
    inlineBodiesStarted: inlineBodiesStarted.length,
    allQueuedPublishedWhileInlineRan,
    queuedBranchesPublished: stepPublishedAt.size,
    /** From the fold's first createBatch POST to the last queued message. */
    lastQueuedVisibleMs:
      Math.max(...stepPublishedAt.values()) - (firstBatchPostAt ?? 0),
  };
}

describe('wide fan-out dispatch', () => {
  afterEach(() => {
    setWorld(undefined);
    inlineBodiesStarted.length = 0;
    inlineBodiesReleased = new Promise<void>((resolve) => {
      releaseInlineBodies = resolve;
    });
  });

  it('publishes every queued branch while the inline bodies run, in chunks of at most 16', async () => {
    const result = await runFanout(SPEC_VERSION_CURRENT);

    expect(result.inlineBodiesStarted).toBe(INLINE);
    expect(result.allQueuedPublishedWhileInlineRan).toBe(true);
    expect(result.queuedBranchesPublished).toBe(BRANCHES - INLINE);
    // The pair chunk (6 rows), then the 61 plain creates in chunks of at
    // most 16.
    expect([...result.batchSizes].sort((a, b) => b - a)).toEqual([
      16, 16, 16, 13, 6,
    ]);
    // A 16-row chunk commits in ~90 ms and publishes in ~80 ms here, where a
    // 32-row chunk takes ~170 ms and then ~160 ms.
    expect(result.lastQueuedVisibleMs).toBeLessThan(260);
  });
});
