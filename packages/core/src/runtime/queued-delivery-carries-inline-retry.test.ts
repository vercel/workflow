/**
 * A queued delivery of a step that waits on the same step's inline execution
 * in this process, when that inline attempt fails and is retried
 * (workflow#4728), driven through real `workflowEntrypoint` deliveries.
 *
 * The inline execution publishes its retry under the step's dispatch key,
 * the key the waiting delivery's own message was published under. Queues
 * fold the two (world-local returns the in-flight message's id; this fake
 * World does the same), so the waiting delivery is the only message left
 * that can run the retry. It must not ack as `skipped`.
 */
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { stepDispatchIdempotencyKey } from './helpers.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const STEP_NAME = 'retryHandoffStep';
const FLOW_MESSAGE_ID = 'msg_flow';
const STEP_MESSAGE_ID = 'msg_queued_step';

/** The inline body holds until the test releases it, then throws. */
let releaseBody!: () => void;
let bodyReleased = new Promise<void>((resolve) => {
  releaseBody = resolve;
});
let bodyCalls = 0;
registerStepFunction(STEP_NAME, async () => {
  bodyCalls++;
  await bodyReleased;
  throw new Error('transient failure');
});

async function raceQueuedDeliveryWithFailingInlineAttempt() {
  const runId = `wrun_retry_handoff_${Date.now()}`;
  const startedAt = new Date('2024-01-01T00:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    specVersion: SPEC_VERSION_CURRENT,
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: startedAt,
    updatedAt: startedAt,
    startedAt,
    deploymentId: 'test-deployment',
  };
  let seq = 1;
  const durable: Event[] = [
    {
      eventId: slotToEventId(seq),
      runId,
      createdAt: startedAt,
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
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

  let correlationId: string | undefined;
  let stepInput: unknown;
  /** Keys of messages in flight, as world-local tracks them. */
  const inflight = new Map<string, string>();
  const published: { message: any; opts: any; messageId: string }[] = [];

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
        if (data.eventType === 'step_started') {
          correlationId ??= data.correlationId;
          stepInput ??= data.eventData?.input;
          return {
            event: record(data),
            step: {
              runId,
              stepId: data.correlationId,
              stepName: STEP_NAME,
              status: 'running' as const,
              attempt: 1,
              input: stepInput,
              startedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
        return { event: record(data) };
      }),
      list: vi.fn(async () => ({
        data: [...durable],
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    // world-local's keyed publish: a key that is still in flight returns the
    // in-flight message's id and queues nothing.
    queue: vi.fn(async (_queueName: string, message: any, opts: any) => {
      const key = opts?.idempotencyKey;
      const messageId =
        (key && inflight.get(key)) || `msg_published_${published.length}`;
      published.push({ message, opts, messageId });
      return { messageId };
    }),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const entry = workflowEntrypoint(`
    const retryHandoffStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("${STEP_NAME}");
    async function workflow() {
      return await retryHandoffStep();
    };globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`);
  await entry(new Request('https://example.test'));

  // The orchestrator delivery starts the step inline; its body holds.
  const flowDelivery = handler(
    { runId, requestedAt: new Date() },
    {
      requestId: 'req_flow',
      attempt: 1,
      queueName: '__wkf_workflow_workflow',
      messageId: FLOW_MESSAGE_ID,
    }
  );
  await vi.waitFor(() => expect(bodyCalls).toBe(1));
  if (!correlationId) throw new Error('expected an inline step_started');
  const stepId = correlationId;

  // A queued delivery of the same step, published under its dispatch key by
  // a concurrent replay, arrives while the inline body runs.
  inflight.set(stepDispatchIdempotencyKey(stepId, STEP_NAME), STEP_MESSAGE_ID);
  const contention = vi.spyOn(runtimeLogger, 'warn');
  const queuedDelivery = handler(
    {
      runId,
      stepId,
      stepName: STEP_NAME,
      requestedAt: new Date(),
    },
    {
      requestId: 'req_step',
      attempt: 1,
      queueName: '__wkf_workflow_workflow',
      messageId: STEP_MESSAGE_ID,
    }
  );
  await vi.waitFor(() =>
    expect(
      contention.mock.calls.some(([msg]) =>
        String(msg).includes('Step execution already in flight')
      )
    ).toBe(true)
  );

  // The inline attempt fails while the queued delivery waits on it.
  releaseBody();
  const [flowResult, queuedResult] = await Promise.all([
    flowDelivery,
    queuedDelivery,
  ]);

  // The queue redelivers the message that carries the retry.
  const redelivery = () =>
    handler(
      { runId, stepId, stepName: STEP_NAME, requestedAt: new Date() },
      {
        requestId: 'req_step_2',
        attempt: 2,
        queueName: '__wkf_workflow_workflow',
        messageId: STEP_MESSAGE_ID,
      }
    );

  return { stepId, flowResult, queuedResult, published, redelivery };
}

describe('a queued delivery waiting on a failing inline attempt', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    bodyCalls = 0;
    bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
  });

  it('redelivers to run the retry the inline attempt folded into it', async () => {
    const { stepId, flowResult, queuedResult, published, redelivery } =
      await raceQueuedDeliveryWithFailingInlineAttempt();

    // The inline attempt published its retry under the dispatch key, so the
    // queue folded it into the waiting delivery's message.
    const retries = published.filter((p) => p.message.stepId === stepId);
    expect(retries).toHaveLength(1);
    expect(retries[0].opts.idempotencyKey).toBe(
      stepDispatchIdempotencyKey(stepId, STEP_NAME)
    );
    expect(retries[0].messageId).toBe(STEP_MESSAGE_ID);
    expect(flowResult).toBeUndefined();

    // That message must redeliver after the retry's backoff rather than ack.
    expect(queuedResult).toEqual({ timeoutSeconds: expect.any(Number) });
    expect(bodyCalls).toBe(1);

    // The redelivery runs attempt 2.
    await redelivery();
    expect(bodyCalls).toBe(2);
  });
});
