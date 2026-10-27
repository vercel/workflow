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

const QUEUE_NAME = '__wkf_workflow_workflow';
const STEP_MESSAGE_ID = 'msg_queued_step';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Fails its first attempt once released; later attempts succeed. */
const FAILING_STEP = 'retryHandoffFailingStep';
/** Succeeds once released. */
const SIBLING_STEP = 'retryHandoffSiblingStep';
let failingGate = gate();
let siblingGate = gate();
const calls = { [FAILING_STEP]: 0, [SIBLING_STEP]: 0 };
registerStepFunction(FAILING_STEP, async () => {
  calls[FAILING_STEP]++;
  if (calls[FAILING_STEP] > 1) return 'ok';
  await failingGate.opened;
  throw new Error('transient failure');
});
registerStepFunction(SIBLING_STEP, async () => {
  calls[SIBLING_STEP]++;
  await siblingGate.opened;
  return 'ok';
});

/**
 * A fake World whose `queue` folds a keyed publish into a message still in
 * flight under that key, as world-local does, and one orchestrator delivery
 * that starts `steps` inline (their bodies hold on their gates). Then a queued
 * delivery of the failing step, keyed in flight under its dispatch key,
 * arrives and waits on the inline execution.
 */
async function startRaceOnFailingStep(steps: string[]) {
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

  const stepNames = new Map<string, string>();
  const stepInputs = new Map<string, unknown>();
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
          const id = data.correlationId;
          if (data.eventData?.stepName)
            stepNames.set(id, data.eventData.stepName);
          if (!stepInputs.has(id)) stepInputs.set(id, data.eventData?.input);
          return {
            event: record(data),
            step: {
              runId,
              stepId: id,
              stepName: stepNames.get(id),
              status: 'running' as const,
              attempt: 1,
              input: stepInputs.get(id),
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
    queue: vi.fn(async (_queueName: string, message: any, opts: any) => {
      const key = opts?.idempotencyKey;
      const messageId =
        (key && inflight.get(key)) || `msg_published_${published.length}`;
      published.push({ message, opts, messageId });
      return { messageId };
    }),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const declarations = steps
    .map(
      (name, i) =>
        `const s${i} = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("${name}");`
    )
    .join('\n');
  const entry = workflowEntrypoint(`
    ${declarations}
    async function workflow() {
      return await Promise.all([${steps.map((_, i) => `s${i}()`).join(', ')}]);
    };globalThis.__private_workflows = new Map();
    globalThis.__private_workflows.set("workflow", workflow);`);
  await entry(new Request('https://example.test'));

  const flowDelivery = handler(
    { runId, requestedAt: new Date() },
    {
      requestId: 'req_flow',
      attempt: 1,
      queueName: QUEUE_NAME,
      messageId: 'msg_flow',
    }
  );
  await vi.waitFor(() => {
    for (const name of steps) expect(calls[name as keyof typeof calls]).toBe(1);
  });
  const stepId = [...stepNames].find(([, name]) => name === FAILING_STEP)?.[0];
  if (!stepId) throw new Error('expected an inline step_started');
  const dispatchKey = stepDispatchIdempotencyKey(stepId, FAILING_STEP);

  // Contention logs at warn today; #4545 may move it to debug.
  const warn = vi.spyOn(runtimeLogger, 'warn');
  const debug = vi.spyOn(runtimeLogger, 'debug');
  const deliverQueuedStep = (attempt: number) =>
    handler(
      { runId, stepId, stepName: FAILING_STEP, requestedAt: new Date() },
      {
        requestId: `req_step_${attempt}`,
        attempt,
        queueName: QUEUE_NAME,
        messageId: STEP_MESSAGE_ID,
      }
    );
  inflight.set(dispatchKey, STEP_MESSAGE_ID);
  const queuedDelivery = deliverQueuedStep(1);
  await vi.waitFor(() =>
    expect(
      [...warn.mock.calls, ...debug.mock.calls].some(([msg]) =>
        String(msg).includes('Step execution already in flight')
      )
    ).toBe(true)
  );

  return {
    stepId,
    dispatchKey,
    durable,
    published,
    flowDelivery,
    queuedDelivery,
    /** The queue redelivers the message that carries the retry. */
    redeliver: () => deliverQueuedStep(2),
  };
}

const stepRetries = (published: { message: any }[], stepId: string) =>
  published.filter((p) => p.message.stepId === stepId);

describe('a queued delivery waiting on a failing inline attempt', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    calls[FAILING_STEP] = 0;
    calls[SIBLING_STEP] = 0;
    failingGate = gate();
    siblingGate = gate();
  });

  it('redelivers to run the retry the inline attempt folded into it', async () => {
    const race = await startRaceOnFailingStep([FAILING_STEP]);

    failingGate.open();
    const [flowResult, queuedResult] = await Promise.all([
      race.flowDelivery,
      race.queuedDelivery,
    ]);

    // The inline attempt published its retry under the dispatch key, so the
    // queue folded it into the waiting delivery's message.
    const retries = stepRetries(race.published, race.stepId);
    expect(retries).toHaveLength(1);
    expect(retries[0].opts.idempotencyKey).toBe(race.dispatchKey);
    expect(retries[0].messageId).toBe(STEP_MESSAGE_ID);
    expect(flowResult).toBeUndefined();

    // That message must redeliver after the retry's backoff rather than ack.
    expect(queuedResult).toEqual({ timeoutSeconds: expect.any(Number) });
    expect(calls[FAILING_STEP]).toBe(1);

    await race.redeliver();
    expect(calls[FAILING_STEP]).toBe(2);
  });

  it('stays in flight until the retry is published when a sibling inline step outlasts the failure', async () => {
    const race = await startRaceOnFailingStep([FAILING_STEP, SIBLING_STEP]);

    failingGate.open();
    await vi.waitFor(() =>
      expect(
        race.durable.some(
          (e) =>
            e.eventType === 'step_retrying' && e.correlationId === race.stepId
        )
      ).toBe(true)
    );
    // The inline batch publishes the retry only once the sibling settles. If
    // the waiting delivery returned now, its redelivery could finish the
    // retried attempt and ack (the sibling still pending) before that
    // publish, which would then land on a spent key.
    let queuedSettled = false;
    race.queuedDelivery.then(() => {
      queuedSettled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(queuedSettled).toBe(false);
    expect(stepRetries(race.published, race.stepId)).toHaveLength(0);

    siblingGate.open();
    const [, queuedResult] = await Promise.all([
      race.flowDelivery,
      race.queuedDelivery,
    ]);
    const retries = stepRetries(race.published, race.stepId);
    expect(retries).toHaveLength(1);
    expect(retries[0].messageId).toBe(STEP_MESSAGE_ID);
    expect(queuedResult).toEqual({ timeoutSeconds: expect.any(Number) });

    // The redelivery runs attempt 2, sees every step done and finishes the run.
    await race.redeliver();
    expect(calls[FAILING_STEP]).toBe(2);
    expect(race.durable.some((e) => e.eventType === 'run_completed')).toBe(
      true
    );
  });
});
