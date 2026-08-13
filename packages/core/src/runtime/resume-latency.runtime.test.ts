/**
 * End-to-end coverage for hook-resume TTR telemetry through the real
 * `workflowEntrypoint` replay loop: a resume delivery carrying producer
 * timing must close the measurement on the first durable step that follows
 * it — exactly once, with phases that add up to the total — and a resume
 * whose next step is queued instead of run inline must hand the boundaries to
 * that step's message so the receiving invocation finishes the measurement.
 *
 * Modeled on resume-hook.consumer-preload.test.ts (same fake World, seeded VM
 * and real ULID event IDs), with a workflow that runs steps after the hook
 * resolves.
 *
 * `Date.now()` is replaced by a counter that advances one millisecond per
 * call, which makes every boundary distinct and strictly increasing without
 * pinning the assertions to a brittle exact schedule. The properties asserted
 * — presence, additivity, dimensions, and which step reports — hold for any
 * such clock.
 */
import { trace as otelTrace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { EntityConflictError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type HookResumeTiming,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowInvokePayload,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
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
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { createContext } from '../vm/index.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

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

const TOTAL_KEY = 'workflow.resume.total_ms';
const PHASE_KEYS = [
  'workflow.resume.phase.producer_prep_ms',
  'workflow.resume.phase.queue_delivery_ms',
  'workflow.resume.phase.resume_setup_ms',
  'workflow.resume.phase.replay_ms',
  'workflow.resume.phase.step_dispatch_ms',
  'workflow.resume.phase.step_claim_ms',
  'workflow.resume.phase.step_prepare_ms',
] as const;

/**
 * The fake clock's first reading. Producer boundaries sit below it so the
 * whole sequence stays ordered across the (notionally separate) machines.
 */
const CLOCK_BASE_MS = 1_800_000_000_000;
const PRODUCER_TIMING: HookResumeTiming = {
  resumeRequestedAtMs: CLOCK_BASE_MS - 120,
  queuePublishRequestedAtMs: CLOCK_BASE_MS - 80,
  strategy: 'parallel',
};

function stepSpans(): ReadableSpan[] {
  return spanExporter
    .getFinishedSpans()
    .filter((s) => s.name.startsWith('step.execute '));
}

function stepSpan(stepName: string): ReadableSpan | undefined {
  return stepSpans().find((s) => s.attributes['step.name'] === stepName);
}

/** The named step's span attributes, failing the test if it never ran. */
function stepAttributes(stepName: string): ReadableSpan['attributes'] {
  const span = stepSpan(stepName);
  if (!span) throw new Error(`no step.execute span for "${stepName}"`);
  return span.attributes;
}

/**
 * The resume timing forwarded onto a dispatched step message, failing the
 * test if the runtime did not hand one off.
 */
function forwardedTiming(
  message: WorkflowInvokePayload | undefined
): HookResumeTiming {
  const timing = message?.hookResumeTiming;
  if (!timing) throw new Error('expected the step message to carry timing');
  return timing;
}

function sumPhases(attrs: ReadableSpan['attributes']): number {
  return PHASE_KEYS.reduce(
    (total, key) => total + ((attrs[key] as number | undefined) ?? 0),
    0
  );
}

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

/**
 * Two sequential steps after the hook resolves, so a scenario can assert that
 * only the first one reports the resumption.
 */
const SEQUENTIAL_WORKFLOW = `
  const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const firstStep = useStep("firstStep");
  const secondStep = useStep("secondStep");

  async function workflow(token) {
    const hook = createHook({ token });
    const payload = await hook;
    const a = await firstStep({ value: payload.value });
    return await secondStep({ value: a });
  }
  ${getWorkflowTransformCode('workflow')}
`;

/**
 * A step kicked off BEFORE the hook resolves, so on the resume delivery it is
 * already `step_created` and pending. Nothing then needs lazy creation, the
 * inline batch is empty, and the runtime dispatches it as a step message —
 * the hand-off path.
 */
const PENDING_STEP_WORKFLOW = `
  const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const pendingStep = useStep("pendingStep");

  async function workflow(token) {
    const hook = createHook({ token });
    const inFlight = pendingStep({ started: true });
    const payload = await hook;
    return (await inFlight) + ":" + payload.value;
  }
  ${getWorkflowTransformCode('workflow')}
`;

/**
 * Two steps kicked off before the hook resolves. Neither needs creation on the
 * resume delivery, so the dispatch loop classifies both — which is what lets a
 * scenario make the FIRST one owned-recovery or backstopped and check where
 * the measurement ends up.
 */
const TWO_PENDING_STEPS_WORKFLOW = `
  const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const pendingStep = useStep("pendingStep");
  const otherStep = useStep("otherStep");

  async function workflow(token) {
    const hook = createHook({ token });
    const a = pendingStep({ started: true });
    const b = otherStep({ started: true });
    const payload = await hook;
    return (await a) + ":" + (await b) + ":" + payload.value;
  }
  ${getWorkflowTransformCode('workflow')}
`;

/**
 * Two steps started in parallel AFTER the hook resolves, so both are lazy
 * inline in one batch — the shape where the batch's first step can lose its
 * atomic create-claim while its sibling proceeds.
 */
const PARALLEL_INLINE_WORKFLOW = `
  const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const firstStep = useStep("firstStep");
  const secondStep = useStep("secondStep");

  async function workflow(token) {
    const hook = createHook({ token });
    const payload = await hook;
    const [a, b] = await Promise.all([
      firstStep({ value: payload.value }),
      secondStep({ value: payload.value }),
    ]);
    return a + ":" + b;
  }
  ${getWorkflowTransformCode('workflow')}
`;

/**
 * `Date.now()` as read by the first line of a step body. With the counter
 * clock this is exactly one tick past the runtime's last reading, which is how
 * the T7 boundary is pinned to the instant before user code.
 */
let bodyEntryClock: number | undefined;

registerStepFunction('firstStep', async (arg: { value: string }) => {
  bodyEntryClock ??= Date.now();
  return arg.value;
});
registerStepFunction('secondStep', async (arg: { value: string }) => {
  bodyEntryClock ??= Date.now();
  return arg.value;
});
registerStepFunction('pendingStep', async () => 'pending-done');
registerStepFunction('otherStep', async () => 'other-done');

/** The queue message id every scenario's delivery arrives under. */
const MESSAGE_ID = 'msg_workflow';

interface ScenarioOptions {
  /** Which workflow (and therefore which dispatch shape) to drive. */
  workflow?:
    | 'sequential'
    | 'pendingStep'
    | 'twoPendingSteps'
    | 'parallelInline';
  /** Producer timing on the delivery; omit to model an older producer. */
  timing?: HookResumeTiming | undefined;
  /**
   * Deliver as a queued step message (`stepId`) rather than a resume, using
   * this timing — the receiving half of the dispatch hand-off.
   */
  stepDelivery?: { stepId: string; stepName: string };
  /** Queue delivery count, so a redelivery/retry can be modeled. */
  attempt?: number;
  /**
   * Where this invocation's fake clock starts. A second invocation in the
   * same test must continue past the first one's boundaries — it models a
   * different machine later in wall-clock time, not a clock rewind.
   */
  clockStart?: number;
  /**
   * Seed a `step_started` for the pending step, so the world reports the next
   * execution as attempt 2 — the shape a redelivery of a step message whose
   * previous delivery already claimed the step actually sees.
   */
  priorStepStarted?: boolean;
  /**
   * The consuming deployment's own id. Setting it to anything but the run's
   * pinned deployment models a misrouted delivery, which the affinity guard
   * re-routes to the pinned deployment instead of replaying.
   */
  ambientDeploymentId?: string;
  /**
   * Stamp a live inline-ownership lease on the FIRST pending step by seeding
   * a recent `step_started` carrying this owner. `MESSAGE_ID` makes this
   * delivery the owner (owned recovery — the step re-executes inline here);
   * any other id makes it someone else's live lease (a delayed backstop wake
   * instead of a step dispatch).
   */
  pendingStepOwner?: string;
  /**
   * Reject the first lazy `step_started` claim with `EntityConflictError`,
   * modelling a concurrent invocation winning the atomic create-claim for the
   * batch's first step while its sibling proceeds.
   */
  failFirstLazyClaim?: boolean;
}

const WORKFLOW_SOURCES = {
  sequential: SEQUENTIAL_WORKFLOW,
  pendingStep: PENDING_STEP_WORKFLOW,
  twoPendingSteps: TWO_PENDING_STEPS_WORKFLOW,
  parallelInline: PARALLEL_INLINE_WORKFLOW,
} as const;

async function runScenario(options: ScenarioOptions = {}) {
  // Monotonic fake clock: every reading is distinct and increasing, so the
  // TTR boundary set is always well-ordered but never a fixed schedule.
  const clockStart = options.clockStart ?? CLOCK_BASE_MS;
  let clock = clockStart;
  vi.spyOn(Date, 'now').mockImplementation(() => clock++);

  const workflowSource = WORKFLOW_SOURCES[options.workflow ?? 'sequential'];
  const runId = 'wrun_resume_ttr';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_resume_ttr';
  const hookToken = 'resume-ttr-token';
  const resumeId = 'resume-ttr-1';
  const payloadDigest = 'd'.repeat(64);
  const startedAt = new Date('2026-05-19T12:00:00.000Z');

  const workflowArgs = await dehydrateWorkflowArguments(
    [hookToken],
    runId,
    undefined
  );

  // Correlation ids the seeded VM derives during replay, in the order the
  // workflow mints them.
  const { globalThis: vmGlobalThis } = createContext({
    seed: `${runId}:${workflowName}:${deploymentId}`,
    fixedTimestamp: +startedAt,
  });
  const vmUlid = monotonicFactory(() => vmGlobalThis.Math.random());
  const hookCorrelationId = `hook_${vmUlid(+startedAt)}`;
  const pendingStepCorrelationId = `step_${vmUlid(+startedAt)}`;
  const otherStepCorrelationId = `step_${vmUlid(+startedAt)}`;

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
  const event = (data: CreateEventRequest): Event => {
    const t = +startedAt + ++eventIndex * 100;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(eventIndex),
      createdAt: new Date(t),
    } as Event;
  };

  const payloadBytes = await dehydrateStepReturnValue(
    { value: 'resumed' },
    runId,
    undefined
  );

  const durableEvents: Event[] = [
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
  ];
  const preCreatedSteps: Array<{ correlationId: string; stepName: string }> =
    options.workflow === 'pendingStep'
      ? [{ correlationId: pendingStepCorrelationId, stepName: 'pendingStep' }]
      : options.workflow === 'twoPendingSteps'
        ? [
            {
              correlationId: pendingStepCorrelationId,
              stepName: 'pendingStep',
            },
            { correlationId: otherStepCorrelationId, stepName: 'otherStep' },
          ]
        : [];
  for (const preCreated of preCreatedSteps) {
    durableEvents.push(
      event({
        eventType: 'step_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: preCreated.correlationId,
        eventData: {
          stepName: preCreated.stepName,
          workflowName,
          input: await dehydrateStepArguments(
            {
              args: [{ started: true }],
              closureVars: undefined,
              thisVal: undefined,
            },
            runId,
            undefined
          ),
        },
      })
    );
  }
  if (options.priorStepStarted) {
    durableEvents.push(
      event({
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: pendingStepCorrelationId,
        eventData: { stepName: 'pendingStep' },
      } as CreateEventRequest)
    );
  }
  if (options.pendingStepOwner !== undefined) {
    // Dated at the fake clock's start so the ownership lease is still live
    // when the dispatch loop evaluates it. `event()`'s own timestamps sit
    // months earlier, which would read as an expired lease.
    durableEvents.push({
      ...event({
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: pendingStepCorrelationId,
        eventData: {
          stepName: 'pendingStep',
          ownerMessageId: options.pendingStepOwner,
        },
      } as CreateEventRequest),
      createdAt: new Date(clockStart),
    } as Event);
  }
  // The producer's direct write already landed, so the consumer's hoisted
  // write converges on it — the common parallel-path shape.
  durableEvents.push({
    ...event({
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: hookCorrelationId,
      eventData: { token: hookToken, payload: payloadBytes },
    }),
    resumeId,
  } as Event);

  const createdEvents: CreateEventRequest[] = [];
  let lazyClaimRejected = false;

  const listEvents = vi.fn(async () => ({
    data: [...durableEvents],
    hasMore: false,
    cursor: durableEvents.at(-1)?.eventId ?? null,
  }));

  const buildStepEntity = (correlationId: string | undefined) => {
    const created = durableEvents.find(
      (e) => e.eventType === 'step_created' && e.correlationId === correlationId
    );
    const data = created?.eventData as
      | { stepName?: string; input?: unknown }
      | undefined;
    const starts = durableEvents.filter(
      (e) => e.eventType === 'step_started' && e.correlationId === correlationId
    ).length;
    return {
      runId,
      stepId: correlationId,
      stepName: data?.stepName,
      status: 'running',
      attempt: starts,
      input: data?.input,
      startedAt: new Date(+startedAt),
      createdAt: new Date(+startedAt),
      updatedAt: new Date(+startedAt),
    };
  };

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: CreateEventParams
    ) => {
      createdEvents.push(request);

      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...durableEvents],
          cursor: durableEvents.at(-1)?.eventId ?? null,
          hasMore: false,
          maxEvents: 25_000,
        };
      }

      if (request.eventType === 'hook_received') {
        const canonical = durableEvents.find(
          (e) => e.eventType === 'hook_received' && e.resumeId === resumeId
        );
        if (params?.preloadEvents !== true) {
          return { event: canonical };
        }
        return {
          event: canonical,
          run: workflowRun,
          events: [...durableEvents],
          cursor: durableEvents.at(-1)?.eventId ?? null,
          hasMore: false,
          maxEvents: 25_000,
        };
      }

      // Lazy step start: synthesize the step_created the world would create.
      const lazyStepStart =
        request.eventType === 'step_started' &&
        !!request.eventData &&
        (request.eventData as { input?: unknown }).input !== undefined;
      if (lazyStepStart && options.failFirstLazyClaim && !lazyClaimRejected) {
        // A concurrent invocation won the atomic create-claim for this step.
        // The real server answers the loser with a 409.
        lazyClaimRejected = true;
        throw new EntityConflictError('step already created');
      }
      let effective = request;
      if (lazyStepStart) {
        const lazy = request.eventData as {
          stepName?: string;
          input?: unknown;
        };
        durableEvents.push(
          event({
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: request.correlationId,
            eventData: {
              stepName: lazy.stepName,
              workflowName,
              input: lazy.input,
            },
          } as CreateEventRequest)
        );
        const { input: _input, ...startData } = lazy;
        effective = {
          ...request,
          eventData: startData,
        } as CreateEventRequest;
      }

      const created = event(effective);
      durableEvents.push(created);

      if (effective.eventType === 'step_started') {
        return {
          event: created,
          step: buildStepEntity(effective.correlationId),
          ...(lazyStepStart ? { stepCreated: true } : {}),
        };
      }
      return { event: created };
    }
  );

  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;
  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_resume_ttr' });

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { deploymentAffinity: true },
    getDeploymentId: vi.fn(
      async () => options.ambientDeploymentId ?? deploymentId
    ),
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: { list: listEvents, create: createEvent },
    runs: { get: vi.fn(async () => workflowRun) },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const handler = workflowEntrypoint(workflowSource);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  const message: Record<string, unknown> = options.stepDelivery
    ? {
        runId,
        stepId: options.stepDelivery.stepId,
        stepName: options.stepDelivery.stepName,
      }
    : {
        runId,
        hookInput: {
          hookId: hookCorrelationId,
          resumeId,
          token: hookToken,
          payload: payloadBytes,
          payloadDigest,
          deploymentId,
        },
      };
  if (options.timing !== undefined) {
    message.hookResumeTiming = options.timing;
  }

  await capturedHandler?.(message, {
    queueName: `__wkf_workflow_${workflowName}`,
    messageId: MESSAGE_ID,
    attempt: options.attempt ?? 1,
  });

  const queuedMessages = queue.mock.calls.map(
    ([, payload]) => payload as WorkflowInvokePayload
  );
  /** Step messages this invocation enqueued, in order. */
  const dispatchedStepMessages = queuedMessages.filter(
    (payload) => payload?.stepId !== undefined
  );

  return {
    runId,
    pendingStepCorrelationId,
    otherStepCorrelationId,
    queuedMessages,
    dispatchedStepMessages,
    createdEvents,
    queue,
  };
}

describe('hook-resume TTR telemetry (runtime)', () => {
  beforeEach(() => {
    spanExporter.reset();
    bodyEntryClock = undefined;
  });

  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    spanExporter.reset();
  });

  it('reports total TTR and every phase on the first step after the resume', async () => {
    await runScenario({ timing: PRODUCER_TIMING });

    const attrs = stepAttributes('firstStep');
    expect(attrs[TOTAL_KEY]).toBeTypeOf('number');
    for (const key of PHASE_KEYS) {
      expect(attrs[key], `missing phase ${key}`).toBeTypeOf('number');
    }
    expect(attrs['workflow.resume.trigger']).toBe('hook');
    expect(attrs['workflow.resume.strategy']).toBe('parallel');
    expect(attrs['workflow.resume.step_execution']).toBe('inline');
    // The hoisted hook_received write returned a usable preload, so neither
    // run_started nor the initial events.list ran.
    expect(attrs['workflow.resume.setup_source']).toBe('hook_preload');
  });

  it('reports phases that sum to the total', async () => {
    await runScenario({ timing: PRODUCER_TIMING });

    const attrs = stepAttributes('firstStep');
    expect(sumPhases(attrs)).toBe(attrs[TOTAL_KEY]);
  });

  it('reports the resumption on exactly one step', async () => {
    await runScenario({ timing: PRODUCER_TIMING });

    // Both steps ran (the workflow chains them) but only the first — the one
    // that immediately followed the resume — carries the measurement.
    expect(stepSpan('secondStep')).toBeDefined();
    expect(stepSpan('secondStep')?.attributes[TOTAL_KEY]).toBeUndefined();
    expect(
      stepSpans().filter((s) => s.attributes[TOTAL_KEY] !== undefined)
    ).toHaveLength(1);
  });

  it('emits nothing for a queue message with no timing (an older producer)', async () => {
    await runScenario({ timing: undefined });

    expect(stepSpans().length).toBeGreaterThan(0);
    for (const span of stepSpans()) {
      expect(span.attributes[TOTAL_KEY]).toBeUndefined();
      for (const key of PHASE_KEYS) {
        expect(span.attributes[key]).toBeUndefined();
      }
    }
  });

  it('runs the resume normally when the timing itself is malformed', async () => {
    // A telemetry field must never be able to fail the delivery: an
    // unparseable value is dropped and the run proceeds without a
    // measurement, rather than throwing on every redelivery.
    const { createdEvents } = await runScenario({
      timing: {
        resumeRequestedAtMs: Number.NaN,
        queuePublishRequestedAtMs: CLOCK_BASE_MS - 80,
        strategy: 'parallel',
      },
    });

    expect(createdEvents.some((e) => e.eventType === 'run_completed')).toBe(
      true
    );
    expect(stepSpans().length).toBeGreaterThan(0);
    for (const span of stepSpans()) {
      expect(span.attributes[TOTAL_KEY]).toBeUndefined();
    }
  });

  it('emits nothing when the producer clock runs ahead of the consumer', async () => {
    // A producer whose clock is far ahead makes T1 land after T2; a negative
    // phase is never reported, so the whole sample is dropped.
    await runScenario({
      timing: {
        resumeRequestedAtMs: CLOCK_BASE_MS + 60_000,
        queuePublishRequestedAtMs: CLOCK_BASE_MS + 60_100,
        strategy: 'parallel',
      },
    });

    for (const span of stepSpans()) {
      expect(span.attributes[TOTAL_KEY]).toBeUndefined();
    }
  });

  it('carries the boundaries onto a dispatched step message', async () => {
    const { dispatchedStepMessages, pendingStepCorrelationId } =
      await runScenario({
        workflow: 'pendingStep',
        timing: PRODUCER_TIMING,
      });

    expect(dispatchedStepMessages).toHaveLength(1);
    const dispatched = dispatchedStepMessages[0];
    expect(dispatched.stepId).toBe(pendingStepCorrelationId);
    const forwarded = forwardedTiming(dispatched);
    // Producer boundaries survive verbatim...
    expect(forwarded.resumeRequestedAtMs).toBe(
      PRODUCER_TIMING.resumeRequestedAtMs
    );
    expect(forwarded.queuePublishRequestedAtMs).toBe(
      PRODUCER_TIMING.queuePublishRequestedAtMs
    );
    expect(forwarded.strategy).toBe('parallel');
    // ...and this invocation's own boundaries ride along so the receiving
    // invocation can finish the measurement.
    expect(forwarded.consumerStartedAtMs).toBeTypeOf('number');
    expect(forwarded.replayStartedAtMs).toBeGreaterThanOrEqual(
      Number(forwarded.consumerStartedAtMs)
    );
    expect(forwarded.nextStepEncounteredAtMs).toBeGreaterThanOrEqual(
      Number(forwarded.replayStartedAtMs)
    );
    expect(forwarded.setupSource).toBe('hook_preload');
    // The invocation that handed the step off does not also report it.
    expect(
      stepSpans().filter((s) => s.attributes[TOTAL_KEY] !== undefined)
    ).toHaveLength(0);
  });

  it('completes the measurement in the invocation that receives the step', async () => {
    // Round 1: the resuming invocation dispatches the step with its timing.
    const first = await runScenario({
      workflow: 'pendingStep',
      timing: PRODUCER_TIMING,
    });
    const forwarded = forwardedTiming(first.dispatchedStepMessages[0]);
    spanExporter.reset();
    setWorld(undefined);
    vi.restoreAllMocks();

    // Round 2: that step message is delivered to a fresh invocation, whose
    // clock picks up where the dispatching one left off.
    const arrivalMs = Number(forwarded.nextStepEncounteredAtMs) + 25;
    await runScenario({
      workflow: 'pendingStep',
      timing: forwarded,
      clockStart: arrivalMs,
      stepDelivery: {
        stepId: first.pendingStepCorrelationId,
        stepName: 'pendingStep',
      },
    });

    const attrs = stepAttributes('pendingStep');
    expect(attrs[TOTAL_KEY]).toBeTypeOf('number');
    expect(sumPhases(attrs)).toBe(attrs[TOTAL_KEY]);
    expect(attrs['workflow.resume.step_execution']).toBe('dispatched');
    expect(attrs['workflow.resume.strategy']).toBe('parallel');
    expect(attrs['workflow.resume.setup_source']).toBe('hook_preload');
    // The queue hop from the resuming invocation to this one falls inside the
    // dispatch phase, so it covers at least that gap.
    expect(
      attrs['workflow.resume.phase.step_dispatch_ms']
    ).toBeGreaterThanOrEqual(
      arrivalMs - Number(forwarded.nextStepEncounteredAtMs)
    );
  });

  it('does not re-report on a redelivery of the same step message', async () => {
    const first = await runScenario({
      workflow: 'pendingStep',
      timing: PRODUCER_TIMING,
    });
    const forwarded = forwardedTiming(first.dispatchedStepMessages[0]);
    spanExporter.reset();
    setWorld(undefined);
    vi.restoreAllMocks();

    // Same message, second delivery, and the previous delivery already
    // claimed the step — so this is attempt 2: a re-execution, not the
    // resumption.
    await runScenario({
      workflow: 'pendingStep',
      timing: forwarded,
      clockStart: Number(forwarded.nextStepEncounteredAtMs) + 25,
      stepDelivery: {
        stepId: first.pendingStepCorrelationId,
        stepName: 'pendingStep',
      },
      attempt: 2,
      priorStepStarted: true,
    });

    for (const span of stepSpans()) {
      expect(span.attributes[TOTAL_KEY]).toBeUndefined();
    }
  });

  it('reports run_started as the setup source when the preload is unusable', async () => {
    // Force the fallback by making the hoisted hook_received write return no
    // preload, so the generic run_started setup runs.
    await runScenarioWithoutPreload();

    const attrs = stepAttributes('firstStep');
    expect(attrs[TOTAL_KEY]).toBeTypeOf('number');
    expect(attrs['workflow.resume.setup_source']).toBe('run_started');
    expect(sumPhases(attrs)).toBe(attrs[TOTAL_KEY]);
  });

  it('leaves a re-routed delivery inside queue_delivery', async () => {
    // Round 1: the message lands on the wrong deployment. The affinity guard
    // re-routes it, and the timing must ride along UNCHANGED — in particular
    // without this deployment's entry time — so the wasted hop is charged to
    // queue delivery rather than disappearing.
    const misrouted = await runScenario({
      timing: PRODUCER_TIMING,
      ambientDeploymentId: 'dpl_somewhere_else',
    });

    const rerouted = misrouted.queue.mock.calls
      .map(([, payload]) => payload as WorkflowInvokePayload)
      .find((payload) => payload?.hookInput !== undefined);
    const reroutedTiming = forwardedTiming(rerouted);
    // Unchanged: no consumer boundaries were stamped by the wrong deployment.
    expect(reroutedTiming).toEqual(PRODUCER_TIMING);
    // Nothing ran here, so nothing reported.
    expect(stepSpans()).toHaveLength(0);

    spanExporter.reset();
    setWorld(undefined);
    vi.restoreAllMocks();

    // Round 2: the pinned deployment receives the re-routed message later.
    const rerouteArrivalMs = CLOCK_BASE_MS + 500;
    await runScenario({
      timing: reroutedTiming,
      clockStart: rerouteArrivalMs,
    });

    const attrs = stepAttributes('firstStep');
    expect(attrs[TOTAL_KEY]).toBeTypeOf('number');
    expect(sumPhases(attrs)).toBe(attrs[TOTAL_KEY]);
    // T2 is this (final) consumer's entry, so the misrouted hop is inside
    // queue_delivery — which therefore covers the whole detour.
    expect(
      attrs['workflow.resume.phase.queue_delivery_ms']
    ).toBeGreaterThanOrEqual(
      rerouteArrivalMs - PRODUCER_TIMING.queuePublishRequestedAtMs
    );
  });

  it('closes the window at the last instant before user code', async () => {
    // The counter clock advances one tick per reading, so if T7 is taken
    // immediately before `stepFn.apply()` then the body's own first reading
    // is exactly one tick later. This pins the boundary past the inner span
    // and the step-context setup that `step_prepare_ms` is defined to cover —
    // anchoring it at `executionStartTime` (before both) would leave a gap.
    await runScenario({ timing: PRODUCER_TIMING });

    const attrs = stepAttributes('firstStep');
    expect(bodyEntryClock).toBeTypeOf('number');
    const t7 = Number(bodyEntryClock) - 1;
    expect(attrs[TOTAL_KEY]).toBe(t7 - PRODUCER_TIMING.resumeRequestedAtMs);
  });

  it('keeps the measurement here when the first pending step is owned recovery', async () => {
    // The first pending step is inline-owned by THIS message, so it
    // re-executes in this invocation; the sibling is dispatched. The
    // measurement must stay with the inline execution rather than being
    // shipped off on the sibling's message.
    const { dispatchedStepMessages, otherStepCorrelationId } =
      await runScenario({
        workflow: 'twoPendingSteps',
        timing: PRODUCER_TIMING,
        pendingStepOwner: MESSAGE_ID,
        attempt: 2,
      });

    expect(dispatchedStepMessages.map((message) => message.stepId)).toContain(
      otherStepCorrelationId
    );
    for (const message of dispatchedStepMessages) {
      expect(message.hookResumeTiming).toBeUndefined();
    }
    // The recovered step is by definition a re-execution (its first attempt
    // already started), so the attempt guard suppresses the sample. What
    // matters here is that it was not misattributed to the sibling.
    for (const span of stepSpans()) {
      expect(span.attributes[TOTAL_KEY]).toBeUndefined();
    }
  });

  it('does not hand the measurement to a delayed backstop wake', async () => {
    // The first pending step is owned by ANOTHER live invocation, so this
    // delivery only arms a backstop for it — not an attempt. The sibling it
    // does dispatch is the first step this delivery actually causes to run,
    // so the measurement goes there.
    const { queuedMessages, dispatchedStepMessages, otherStepCorrelationId } =
      await runScenario({
        workflow: 'twoPendingSteps',
        timing: PRODUCER_TIMING,
        pendingStepOwner: 'msg_some_other_invocation',
      });

    const backstopWakes = queuedMessages.filter(
      (payload) => payload?.stepId === undefined
    );
    expect(backstopWakes.length).toBeGreaterThan(0);
    for (const wake of backstopWakes) {
      expect(wake.hookResumeTiming).toBeUndefined();
    }

    expect(dispatchedStepMessages).toHaveLength(1);
    expect(dispatchedStepMessages[0].stepId).toBe(otherStepCorrelationId);
    expect(dispatchedStepMessages[0].hookResumeTiming).toBeDefined();
  });

  it('drops the sample when every pending step becomes a backstop', async () => {
    // Nothing is attempted by this delivery, so there is no step to attribute
    // the resumption to. Reporting it against a wake would credit work this
    // invocation never did.
    const { queuedMessages, dispatchedStepMessages } = await runScenario({
      workflow: 'pendingStep',
      timing: PRODUCER_TIMING,
      pendingStepOwner: 'msg_some_other_invocation',
    });

    expect(dispatchedStepMessages).toHaveLength(0);
    for (const message of queuedMessages) {
      expect(message.hookResumeTiming).toBeUndefined();
    }
    expect(stepSpans()).toHaveLength(0);
  });

  it('still reports when the batch’s first step loses its create-claim', async () => {
    // A concurrent invocation wins the first inline step's atomic
    // create-claim; that step never reaches user code. Its sibling does, and
    // the shared one-shot latch lets it take the measurement instead of the
    // sample being pinned to — and lost with — the first step.
    await runScenario({
      workflow: 'parallelInline',
      timing: PRODUCER_TIMING,
      failFirstLazyClaim: true,
    });

    const reporting = stepSpans().filter(
      (s) => s.attributes[TOTAL_KEY] !== undefined
    );
    expect(reporting).toHaveLength(1);
    const attrs = reporting[0].attributes;
    expect(sumPhases(attrs)).toBe(attrs[TOTAL_KEY]);
    expect(attrs['workflow.resume.step_execution']).toBe('inline');
  });

  it('reports once for a parallel batch where every step runs', async () => {
    await runScenario({
      workflow: 'parallelInline',
      timing: PRODUCER_TIMING,
    });

    expect(stepSpans().length).toBeGreaterThan(1);
    expect(
      stepSpans().filter((s) => s.attributes[TOTAL_KEY] !== undefined)
    ).toHaveLength(1);
  });

  it('reports the sequential dispatch strategy', async () => {
    await runScenario({
      timing: { ...PRODUCER_TIMING, strategy: 'sequential' },
    });

    expect(stepAttributes('firstStep')['workflow.resume.strategy']).toBe(
      'sequential'
    );
  });
});

/**
 * The lazy fast path's fallback: the hoisted `hook_received` write succeeds
 * but returns no usable preload, so the invocation initializes through
 * `run_started` instead. Same fake World as {@link runScenario} with the
 * preload response suppressed.
 */
async function runScenarioWithoutPreload() {
  let clock = CLOCK_BASE_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => clock++);

  const runId = 'wrun_resume_ttr_fallback';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_resume_ttr';
  const hookToken = 'resume-ttr-token';
  const resumeId = 'resume-ttr-fallback';
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
  const event = (data: CreateEventRequest): Event => {
    const t = +startedAt + ++eventIndex * 100;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(eventIndex),
      createdAt: new Date(t),
    } as Event;
  };

  const payloadBytes = await dehydrateStepReturnValue(
    { value: 'resumed' },
    runId,
    undefined
  );
  const durableEvents: Event[] = [
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
    {
      ...event({
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookCorrelationId,
        eventData: { token: hookToken, payload: payloadBytes },
      }),
      resumeId,
    } as Event,
  ];

  const buildStepEntity = (correlationId: string | undefined) => {
    const created = durableEvents.find(
      (e) => e.eventType === 'step_created' && e.correlationId === correlationId
    );
    const data = created?.eventData as
      | { stepName?: string; input?: unknown }
      | undefined;
    return {
      runId,
      stepId: correlationId,
      stepName: data?.stepName,
      status: 'running',
      attempt: 1,
      input: data?.input,
      startedAt: new Date(+startedAt),
      createdAt: new Date(+startedAt),
      updatedAt: new Date(+startedAt),
    };
  };

  const createEvent = vi.fn(
    async (_runId: string, request: CreateEventRequest) => {
      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...durableEvents],
          cursor: durableEvents.at(-1)?.eventId ?? null,
          hasMore: false,
          maxEvents: 25_000,
        };
      }
      if (request.eventType === 'hook_received') {
        // No preload in the response — an older server, or a World that
        // ignored `preloadEvents`.
        return {
          event: durableEvents.find(
            (e) => e.eventType === 'hook_received' && e.resumeId === resumeId
          ),
        };
      }
      const lazyStepStart =
        request.eventType === 'step_started' &&
        !!request.eventData &&
        (request.eventData as { input?: unknown }).input !== undefined;
      let effective = request;
      if (lazyStepStart) {
        const lazy = request.eventData as {
          stepName?: string;
          input?: unknown;
        };
        durableEvents.push(
          event({
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: request.correlationId,
            eventData: {
              stepName: lazy.stepName,
              workflowName,
              input: lazy.input,
            },
          } as CreateEventRequest)
        );
        const { input: _input, ...startData } = lazy;
        effective = {
          ...request,
          eventData: startData,
        } as CreateEventRequest;
      }
      const created = event(effective);
      durableEvents.push(created);
      if (effective.eventType === 'step_started') {
        return {
          event: created,
          step: buildStepEntity(effective.correlationId),
          ...(lazyStepStart ? { stepCreated: true } : {}),
        };
      }
      return { event: created };
    }
  );

  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { deploymentAffinity: true },
    getDeploymentId: vi.fn(async () => deploymentId),
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: {
      list: vi.fn(async () => ({
        data: [...durableEvents],
        hasMore: false,
        cursor: durableEvents.at(-1)?.eventId ?? null,
      })),
      create: createEvent,
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_fallback' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const handler = workflowEntrypoint(SEQUENTIAL_WORKFLOW);
  await handler(new Request('http://localhost', { method: 'POST' }));
  await capturedHandler?.(
    {
      runId,
      hookInput: {
        hookId: hookCorrelationId,
        resumeId,
        token: hookToken,
        payload: payloadBytes,
        payloadDigest: 'e'.repeat(64),
        deploymentId,
      },
      hookResumeTiming: PRODUCER_TIMING,
    },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow_fallback',
      attempt: 1,
    }
  );
}
