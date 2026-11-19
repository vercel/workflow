import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { RetryableError } from '@workflow/errors';
import {
  type Event,
  QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS,
} from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import type {
  AppendOnlyWorld,
  HeldMessage,
} from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';
import { STEP_RESEND_MAX_AGE_MS } from './creator-rules.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A background step whose `step_created` committed and whose message never
// went out (its delivery died, or failed, between the two) is sent again by
// the next orchestrator delivery that is not its message's first, whichever
// message created it (see `stepsToReenqueue`).

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider();

beforeAll(() => {
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  otelTrace.setGlobalTracerProvider(tracerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  otelTrace.disable();
});

const calls = { resend_step: 0, resend_flaky: 0 };
registerStepFunction('resend_step', async () => {
  calls.resend_step++;
  return 5;
});
/** How far past its failure the first attempt of `resend_flaky` retries. */
let flakyRetryAfterMs = 0;
registerStepFunction('resend_flaky', async () => {
  calls.resend_flaky++;
  if (calls.resend_flaky === 1) {
    throw new RetryableError('transient', {
      retryAfter: new Date(Date.now() + flakyRetryAfterMs),
    });
  }
  return 7;
});

beforeEach(() => {
  spanExporter.reset();
  calls.resend_step = 0;
  calls.resend_flaky = 0;
  flakyRetryAfterMs = 0;
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setWorld(undefined);
});

const step = `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("resend_step")`;
const hookAndStepWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s = ${step};
  async function workflow() {
    const hook = createHook({ token: "resend-hook" });
    const [, v] = await Promise.all([hook, s()]);
    return v;
  }${registerWorkflow()}`;
const flaky = `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("resend_flaky")`;
const hookAndFlakyWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s = ${flaky};
  async function workflow() {
    const hook = createHook({ token: "resend-flaky-hook" });
    const [, v] = await Promise.all([hook, s()]);
    return v;
  }${registerWorkflow()}`;
const flakyWorkflow = `const s = ${flaky};
  async function workflow() { return await s(); }${registerWorkflow()}`;
const stepWorkflow = `const s = ${step};
  async function workflow() { return await s(); }${registerWorkflow()}`;

const key = (attribute: Record<string, unknown>) => Object.keys(attribute)[0]!;
const REENQUEUE_COUNT = key(Attribute.WorkflowReenqueueCount(0));
const SKIPPED_TOO_OLD = key(Attribute.WorkflowReenqueueSkippedTooOld(0));

const executeSpans = (): ReadableSpan[] =>
  spanExporter
    .getFinishedSpans()
    .filter((span) => span.name.startsWith('workflow.execute'));

/** The step ids of every step message the run's World was sent. */
const stepMessageIds = (world: AppendOnlyWorld) =>
  stepMessagesOf(world).map(
    (call) => (call.message as { stepId: string }).stepId
  );

/**
 * Sets up `code`, fails the first step message send (the delivery that
 * created the step fails after its `step_created` committed), and delivers
 * the start message. Returns its redelivery, which the World holds.
 */
async function startWithLostStepSend(
  code: string,
  engine: 'node' | 'quickjs',
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = {}
) {
  const setup = await setupOrchestratorRun(code, [], options, engine);
  const { world, start } = setup;
  const asWorld = world.asWorld();
  const queue = asWorld.queue.bind(asWorld);
  let failNext = true;
  asWorld.queue = (async (...args: Parameters<typeof queue>) => {
    if (failNext && (args[1] as { stepId?: string }).stepId !== undefined) {
      failNext = false;
      throw new Error('step send failed');
    }
    return queue(...args);
  }) as typeof queue;
  setWorld(asWorld);
  await expect(world.deliver(start)).rejects.toThrow();
  expect(eventsOf(world, 'step_created')).toHaveLength(1);
  expect(stepMessageIds(world)).toEqual([]);
  const redelivery = world.held.find(
    (held) => held.messageId === start.messageId
  )!;
  expect(redelivery.deliveryCount).toBe(2);
  world.held.splice(world.held.indexOf(redelivery), 1);
  return { ...setup, asWorld, redelivery };
}

describe.each([
  'node',
  'quickjs',
] as const)('step re-send (%s engine)', (engine) => {
  it("re-sends the step from another message's coalesced re-run when the creator's redelivery is coalesced into it, and the run completes", async () => {
    let redelivery: HeldMessage | undefined;
    let coalesced = false;
    const { world, runId, asWorld, ...rest } = await startWithLostStepSend(
      hookAndStepWorkflow,
      engine,
      { coalesce: true }
    );
    redelivery = rest.redelivery;
    // The creator's redelivery comes due while the hook's wake runs (its
    // lease lapsed after a crash, so the wake took the run's key), and is
    // coalesced into it: it is never delivered.
    const list = asWorld.events.list.bind(asWorld.events);
    asWorld.events.list = (async (...args: Parameters<typeof list>) => {
      if (redelivery && !coalesced) {
        world.held.push(redelivery);
        coalesced = world.comeDue(redelivery);
        redelivery = undefined;
      }
      return list(...args);
    }) as typeof list;
    const hookCreated = eventsOf(world, 'hook_created')[0]!;
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hookCreated.correlationId,
      eventData: {
        token: dataOf(hookCreated)?.token,
        payload: await dehydrateStepReturnValue({}, runId, undefined),
      },
    } as Partial<Event>);
    const wake = world.enqueue(ORCHESTRATOR_QUEUE, { runId });

    await world.deliver(wake);
    expect(coalesced).toBe(true);
    // The wake's re-run is not its message's first delivery: it sent the
    // step the start message's first delivery never got out.
    expect(stepMessageIds(world)).toEqual([
      eventsOf(world, 'step_created')[0]!.correlationId,
    ]);
    expect(
      executeSpans().some((span) => span.attributes[REENQUEUE_COUNT] === 1)
    ).toBe(true);
    await world.runUntilIdle();
    expect(calls.resend_step).toBe(1);
    expect(await runResult(world)).toBe(5);
  });

  it('re-sends on a handoff continuation, which is not an attempt', async () => {
    const { world, redelivery } = await startWithLostStepSend(
      stepWorkflow,
      engine
    );
    // The next delivery follows a handoff: `attempt` is 1, `deliveryCount`
    // is 2.
    world.held.push({ ...redelivery, handoffCount: 1 });
    await world.runUntilIdle();
    expect(stepMessageIds(world)).toEqual([
      eventsOf(world, 'step_created')[0]!.correlationId,
    ]);
    expect(await runResult(world)).toBe(5);
  });

  it('re-sends once per invocation across its coalesced re-runs', async () => {
    const { world, redelivery } = await startWithLostStepSend(
      stepWorkflow,
      engine
    );
    const invocationStartedAt = Date.now();
    // Two handler calls of one invocation: the step is still unstarted for
    // the second, which does not send it again.
    await world.deliver({ ...redelivery, invocationStartedAt });
    await world.deliver({
      ...redelivery,
      invocationStartedAt,
      coalescedRerun: 1,
    });
    expect(stepMessageIds(world)).toHaveLength(1);
    // A later invocation sends it again, under the same key.
    await world.deliver({
      ...redelivery,
      deliveryCount: redelivery.deliveryCount + 1,
      invocationStartedAt: invocationStartedAt + 1,
    });
    expect(stepMessageIds(world)).toHaveLength(2);
    const keys = new Set(
      stepMessagesOf(world).map((call) => call.opts?.idempotencyKey)
    );
    expect(keys.size).toBe(1);
  });

  it('leaves a step alone once its creation is past the re-send age bound, and reports it on the span', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { world, redelivery } = await startWithLostStepSend(
      stepWorkflow,
      engine
    );
    vi.setSystemTime(Date.now() + STEP_RESEND_MAX_AGE_MS);
    spanExporter.reset();
    await world.deliver(redelivery);
    expect(stepMessageIds(world)).toEqual([]);
    expect(
      executeSpans().some(
        (span) =>
          span.attributes[SKIPPED_TOO_OLD] === 1 &&
          span.attributes[REENQUEUE_COUNT] === 0
      )
    ).toBe(true);
  });

  it("never leaves a step two live messages, inside the queue's key dedupe window or past it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The queue forgets a key once its window passed, while the step's first
    // message is still held: a re-send then would be a second message.
    const { world, start } = await setupOrchestratorRun(
      stepWorkflow,
      [],
      { keyDedupeWindowMs: QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS },
      engine
    );
    await world.deliver(start);
    const createdAtMs = Date.now();
    const liveStepMessages = () =>
      world.held.filter(
        (held) => (held.message as { stepId?: string }).stepId !== undefined
      );
    expect(liveStepMessages()).toHaveLength(1);
    const redeliver = (deliveryCount: number) =>
      world.deliver({
        ...start,
        deliveryCount,
        invocationStartedAt: Date.now(),
      });

    // Inside the re-send bound the step is sent again, and the queue
    // deduplicates it against the live message.
    vi.setSystemTime(createdAtMs + STEP_RESEND_MAX_AGE_MS - 60_000);
    await redeliver(2);
    expect(stepMessageIds(world)).toHaveLength(2);
    expect(liveStepMessages()).toHaveLength(1);

    // Just past the window the queue would take a re-send as a new message,
    // and none is made.
    vi.setSystemTime(createdAtMs + QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS + 1);
    await redeliver(3);
    expect(stepMessageIds(world)).toHaveLength(2);
    expect(liveStepMessages()).toHaveLength(1);
  });

  it('does not re-send on a first delivery', async () => {
    const { world, redelivery, runId } = await startWithLostStepSend(
      stepWorkflow,
      engine
    );
    spanExporter.reset();
    await world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
    expect(stepMessageIds(world)).toEqual([]);
    expect(
      executeSpans().every(
        (span) => span.attributes[REENQUEUE_COUNT] === undefined
      )
    ).toBe(true);
    // The creator's redelivery does.
    await world.deliver(redelivery);
    expect(stepMessageIds(world)).toHaveLength(1);
  });

  it("re-sends an inline step's background retry from another message's coalesced re-run when the delivery that moved it fails before the send, and the run completes", async () => {
    // The first attempt runs inline, fails, and moves to the step's own
    // message; that message's send fails.
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    const setup = await setupOrchestratorRun(
      hookAndFlakyWorkflow,
      [],
      { coalesce: true },
      engine
    );
    const { world, runId, start } = setup;
    const asWorld = world.asWorld();
    const queue = asWorld.queue.bind(asWorld);
    let failNext = true;
    asWorld.queue = (async (...args: Parameters<typeof queue>) => {
      if (failNext && (args[1] as { stepId?: string }).stepId !== undefined) {
        failNext = false;
        throw new Error('step send failed');
      }
      return queue(...args);
    }) as typeof queue;
    setWorld(asWorld);
    await expect(world.deliver(start)).rejects.toThrow();
    expect(calls.resend_flaky).toBe(1);
    const retrying = eventsOf(world, 'step_retrying');
    expect(retrying).toHaveLength(1);
    expect(dataOf(retrying[0])?.creatorMessageId).toBe(start.messageId);
    expect(stepMessageIds(world)).toEqual([]);
    let redelivery: HeldMessage | undefined = world.held.find(
      (held) => held.messageId === start.messageId
    );
    world.held.splice(world.held.indexOf(redelivery!), 1);

    // The redelivery comes due while the hook's wake runs and is coalesced
    // into it: it is never delivered.
    let coalesced = false;
    const list = asWorld.events.list.bind(asWorld.events);
    asWorld.events.list = (async (...args: Parameters<typeof list>) => {
      if (redelivery && !coalesced) {
        world.held.push(redelivery);
        coalesced = world.comeDue(redelivery);
        redelivery = undefined;
      }
      return list(...args);
    }) as typeof list;
    const hookCreated = eventsOf(world, 'hook_created')[0]!;
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hookCreated.correlationId,
      eventData: {
        token: dataOf(hookCreated)?.token,
        payload: await dehydrateStepReturnValue({}, runId, undefined),
      },
    } as Partial<Event>);
    await world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
    expect(coalesced).toBe(true);
    // The wake's re-run sent the retry the failed delivery never got out.
    expect(stepMessageIds(world)).toEqual([retrying[0]!.correlationId]);

    await world.runUntilIdle();
    expect(calls.resend_flaky).toBe(2);
    expect(await runResult(world)).toBe(7);
  });

  it("runs an inline step's background retry once when its retryAfter outlives the queue's key dedupe window", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    // The retry is due two dedupe windows after the failed attempt, and its
    // message is held that long.
    flakyRetryAfterMs = 2 * QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS;
    const { world, start } = await setupOrchestratorRun(
      flakyWorkflow,
      [],
      { keyDedupeWindowMs: QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS },
      engine
    );
    await world.deliver(start);
    const movedAtMs = Date.now();
    expect(calls.resend_flaky).toBe(1);
    const liveStepMessages = () =>
      world.held.filter(
        (held) => (held.message as { stepId?: string }).stepId !== undefined
      );
    expect(liveStepMessages()).toHaveLength(1);
    const redeliver = (deliveryCount: number) =>
      world.deliver({
        ...start,
        deliveryCount,
        invocationStartedAt: Date.now(),
      });

    // Inside the re-send bound a re-send is deduplicated against the held
    // retry message; past it none is made, though the queue would take one.
    vi.setSystemTime(movedAtMs + STEP_RESEND_MAX_AGE_MS - 60_000);
    await redeliver(2);
    expect(liveStepMessages()).toHaveLength(1);
    vi.setSystemTime(movedAtMs + QUEUE_MIN_STEP_KEY_DEDUPE_WINDOW_MS + 1);
    await redeliver(3);
    expect(liveStepMessages()).toHaveLength(1);

    vi.setSystemTime(movedAtMs + flakyRetryAfterMs + 1000);
    await world.runUntilIdle();
    expect(calls.resend_flaky).toBe(2);
    expect(await runResult(world)).toBe(7);
  });

  it('marks a re-sent step message, whose first delivery reads the log and so does not run a step that already has an outcome', async () => {
    const { world, redelivery } = await startWithLostStepSend(
      stepWorkflow,
      engine
    );
    await world.deliver(redelivery);
    const [resent] = stepMessagesOf(world);
    expect(resent?.message).toMatchObject({ stepResent: true });
    const stepMessage = world.held.find(
      (held) => (held.message as { stepId?: string }).stepId !== undefined
    )!;
    await world.deliver(stepMessage);
    expect(calls.resend_step).toBe(1);
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);

    // A copy of the re-sent message, delivered for the first time after the
    // step completed: what a queue that forgets a step key once its message
    // is acknowledged would deliver for a re-send decided from an older log.
    await world.deliver(
      world.enqueue(stepMessage.queueName, stepMessage.message)
    );
    expect(calls.resend_step).toBe(1);
    await world.runUntilIdle();
    expect(calls.resend_step).toBe(1);
    expect(await runResult(world)).toBe(5);
  });
});
