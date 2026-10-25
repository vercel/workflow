/**
 * vercel/workflow#4457: a parallel branch whose step settles advances without
 * waiting for the steps still pending beside it, on both the queued-step
 * (background) path and the inline path. See `isAdvanceOnlyReplayEnabled`.
 *
 * Each test drives the real entrypoint against an in-memory World whose step
 * bodies park on gates, so a sibling can be held in flight while another
 * branch's step settles.
 */

import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { ulid } from 'ulid';
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
import { registerStepFunction } from './private.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepArguments,
} from './serialization.js';

type Gate = { promise: Promise<void>; open: () => void };

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider();
const WINDOWS_SAFE_WAIT_TIMEOUT_MS = 15_000;

const waitFor = <T>(
  callback: () => T | Promise<T>,
  options: Parameters<typeof vi.waitFor>[1] = {}
) =>
  vi.waitFor(callback, {
    timeout: WINDOWS_SAFE_WAIT_TIMEOUT_MS,
    ...options,
  });

beforeAll(() => {
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  otelTrace.setGlobalTracerProvider(tracerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  otelTrace.disable();
});

const hasExecutionAttribute = (key: string, value: unknown) =>
  spanExporter
    .getFinishedSpans()
    .filter((span) => span.name.startsWith('workflow.execute '))
    .some((span) => span.attributes[key] === value);
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

// Step bodies park on the gate registered for their label (their only
// argument), so a test decides when each one finishes. A label with no gate
// returns at once.
const bodyGates = new Map<string, Gate>();
const bodyFinishes = new Set<string>();
const bodyStarts = new Map<string, number>();
const bodyFailuresRemaining = new Map<string, number>();
registerStepFunction('branchStep', async (label: string) => {
  bodyStarts.set(label, (bodyStarts.get(label) ?? 0) + 1);
  await bodyGates.get(label)?.promise;
  const failuresRemaining = bodyFailuresRemaining.get(label) ?? 0;
  if (failuresRemaining > 0) {
    bodyFailuresRemaining.set(label, failuresRemaining - 1);
    throw new Error(`retry ${label}`);
  }
  bodyFinishes.add(label);
  return label;
});

const workflowSource = (body: string) =>
  `const branchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("branchStep");
  async function workflow() {
    ${body}
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

/** A two-step chain beside a one-step sibling, the sibling listed first. */
const SLOW_BESIDE_CHAIN = workflowSource(`
  await Promise.all([
    branchStep('slow'),
    (async () => {
      await branchStep('fast1');
      await branchStep('fast2');
    })(),
  ]);
  return 'done';
`);

/** Two one-step branches: neither has anything after its step. */
const TWO_LEAVES = workflowSource(`
  await Promise.all([branchStep('slow'), branchStep('fast1')]);
  return 'done';
`);

/** Three one-step branches. */
const THREE_LEAVES = workflowSource(`
  await Promise.all([
    branchStep('slow'),
    branchStep('fast1'),
    branchStep('queued'),
  ]);
  return 'done';
`);

/** A two-step chain beside a one-step sibling, the chain listed first. */
const CHAIN_BESIDE_SLOW = workflowSource(`
  await Promise.all([
    (async () => {
      await branchStep('fast1');
      await branchStep('fast2');
    })(),
    branchStep('slow'),
  ]);
  return 'done';
`);

const RETRY_BESIDE_SLOW = workflowSource(`
  await Promise.all([branchStep('retry'), branchStep('slow')]);
  return 'done';
`);

const DETACHED_AFTER_FAST_BESIDE_SLOW = workflowSource(`
  await Promise.all([
    (async () => {
      await branchStep('fast1');
      const detached = branchStep('detached');
      detached.catch(() => {});
    })(),
    branchStep('slow'),
  ]);
  return 'done';
`);

const INLINE_BATCH_WITH_QUEUED_SIBLING = workflowSource(`
  await Promise.all([
    (async () => {
      await branchStep('fast1');
      await branchStep('fast2');
    })(),
    branchStep('slow'),
    branchStep('queued'),
  ]);
  return 'done';
`);

const TWO_CHAINS_BESIDE_SLOW = workflowSource(`
  await Promise.all([
    branchStep('slow'),
    (async () => {
      await branchStep('a1');
      await branchStep('a2');
    })(),
    (async () => {
      await branchStep('b1');
      await branchStep('b2');
    })(),
  ]);
  return 'done';
`);

const RACE_THEN_DETACHED_TERMINAL_DRAIN = workflowSource(`
  const winner = await Promise.race([
    branchStep('slow'),
    branchStep('fast1'),
  ]);
  const detached = Promise.all([
    branchStep('detached1'),
    branchStep('detached2'),
    branchStep('detached3'),
    branchStep('detached4'),
  ]);
  detached.catch(() => {});
  return winner;
`);

const FAIL_AFTER_RACE = workflowSource(`
  await Promise.race([branchStep('slow'), branchStep('fast1')]);
  throw new Error('boom');
`);

const ATTRIBUTE_FANOUT_BESIDE_SLOW = `
  const branchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("branchStep");
  const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
  async function workflow() {
    await Promise.all([
      branchStep('slow'),
      (async () => {
        await branchStep('fast1');
        await Promise.all([
          setAttributes([{ key: 'advanced', value: 'yes' }]),
          branchStep('next1'),
          branchStep('next2'),
          branchStep('next3'),
        ]);
      })(),
    ]);
    return 'done';
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

interface Harness {
  deliver: (
    message: unknown,
    messageId: string,
    attempt?: number
  ) => Promise<unknown>;
  deliveryCount: () => number;
  events: Event[];
  queued: Array<Record<string, unknown>>;
  /** Hold the `step_started` claim response of the step with this label. */
  claimGates: Map<string, Gate>;
  /** Whether the step with this label has an event of this type. */
  stepHas: (label: string, eventType: string) => boolean;
  /** Event types written after the step with this label completed. */
  writtenAfterCompletionOf: (label: string) => string[];
  /** The queued step-execution message for the step with this label. */
  stepMessageFor: (label: string) => Record<string, unknown> | undefined;
  runsGet: ReturnType<typeof vi.fn>;
  queue: ReturnType<typeof vi.fn>;
  startMessage: Record<string, unknown>;
}

async function setupHarness(
  runId: string,
  workflowCode: string,
  options: {
    runStartedGate?: Gate;
    stepSendGate?: Gate;
    failAdvanceOnlySend?: boolean;
    invokeCapable?: boolean;
    maxConcurrencyCapable?: boolean;
    dropUnknownStepCreatedFields?: boolean;
  } = {}
): Promise<Harness> {
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    specVersion: SPEC_VERSION_CURRENT,
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
  let seq = 1;
  const events: Event[] = [
    {
      eventId: slotToEventId(seq),
      runId,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
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
    events.push(event);
    return event;
  };
  const inputs = new Map<string, unknown>();
  const labels = new Map<string, string>();
  const claimGates = new Map<string, Gate>();
  const learnLabel = async (correlationId: string, input: unknown) => {
    inputs.set(correlationId, input);
    const hydrated = await hydrateStepArguments(input, runId, undefined);
    const args = Array.isArray(hydrated) ? hydrated : hydrated?.args;
    labels.set(correlationId, String(args?.[0]));
  };

  const createStepStarted = async (data: any) => {
    const lazy = data.eventData as { stepName?: string; input?: unknown };
    if (lazy?.input !== undefined) {
      await learnLabel(data.correlationId, lazy.input);
      record({
        eventType: 'step_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: data.correlationId,
        eventData: { stepName: lazy.stepName, input: lazy.input },
      });
    }
    const started = record(data);
    const held = claimGates.get(labels.get(data.correlationId) ?? '');
    if (held) await held.promise;
    return {
      event: started,
      step: {
        runId,
        stepId: data.correlationId,
        stepName: lazy?.stepName,
        status: 'running' as const,
        attempt: 1,
        input: inputs.get(data.correlationId),
        startedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ...(lazy?.input !== undefined ? { stepCreated: true } : {}),
    };
  };

  const create = vi.fn(async (_runId: string, data: any) => {
    if (data.eventType === 'run_started') {
      await options.runStartedGate?.promise;
      if (!events.some((event) => event.eventType === 'run_started')) {
        record({
          ...data,
          createdAt: workflowRun.startedAt,
        });
      }
      return { run: workflowRun, events: [...events] };
    }
    if (data.eventType === 'step_created') {
      await learnLabel(data.correlationId, data.eventData?.input);
      if (options.dropUnknownStepCreatedFields) {
        const { stepName, workflowName, input } = data.eventData ?? {};
        return {
          event: record({
            ...data,
            eventData: { stepName, workflowName, input },
          }),
        };
      }
      return { event: record(data) };
    }
    if (data.eventType === 'step_started') {
      return createStepStarted(data);
    }
    return { event: record(data) };
  });

  const queued: Array<Record<string, unknown>> = [];
  const runsGet = vi.fn(async () => workflowRun);
  let handler!: (message: unknown, metadata: unknown) => Promise<unknown>;
  let deliveryCount = 0;
  const queue = vi.fn(async (_queueName: string, message: any) => {
    if (options.failAdvanceOnlySend && message.advanceOnly === true) {
      throw new Error('advance-only continuation unavailable');
    }
    if (message.stepId !== undefined) await options.stepSendGate?.promise;
    queued.push(message);
    return { messageId: null };
  });
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    ...(options.invokeCapable || options.maxConcurrencyCapable
      ? {
          capabilities: {
            ...(options.invokeCapable ? { invoke: true } : {}),
            ...(options.maxConcurrencyCapable ? { maxConcurrency: true } : {}),
          },
        }
      : {}),
    createQueueHandler: vi.fn((_prefix: string, h: typeof handler) => {
      handler = h;
      return async () => new Response(null, { status: 204 });
    }),
    events: {
      create,
      list: vi.fn(async () => ({
        data: [...events],
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: runsGet },
    queue,
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);
  await workflowEntrypoint(workflowCode)(new Request('https://example.test'));

  const isStep = (e: Event, label: string, eventType: string) =>
    e.eventType === eventType &&
    e.correlationId !== undefined &&
    labels.get(e.correlationId) === label;

  return {
    deliver: (message, messageId, attempt = 1) => {
      deliveryCount++;
      return handler(message, {
        requestId: `req_${messageId}`,
        attempt,
        queueName: '__wkf_workflow_workflow',
        messageId,
      });
    },
    deliveryCount: () => deliveryCount,
    events,
    queued,
    claimGates,
    stepHas: (label, eventType) =>
      events.some((e) => isStep(e, label, eventType)),
    writtenAfterCompletionOf: (label) => {
      const done = events.findIndex((e) => isStep(e, label, 'step_completed'));
      return events.slice(done + 1).map((e) => e.eventType);
    },
    stepMessageFor: (label) =>
      queued.find(
        (m) => typeof m.stepId === 'string' && labels.get(m.stepId) === label
      ),
    runsGet,
    queue,
    startMessage: {
      runId,
      requestedAt: new Date(),
      runInput: {
        input: workflowRun.input,
        deploymentId: workflowRun.deploymentId,
        workflowName: workflowRun.workflowName,
        specVersion: workflowRun.specVersion,
        executionContext: {},
      },
    },
  };
}

// A real ULID: the VM clock of a run whose id encodes its creation time does
// not depend on the stored row, which is what lets an advance-only replay
// skip reading it.
const newRunId = () => `wrun_${ulid()}`;

/** Let a held delivery run until it is blocked on something external. */
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

afterEach(() => {
  bodyGates.clear();
  bodyFinishes.clear();
  bodyStarts.clear();
  bodyFailuresRemaining.clear();
  delete process.env.WORKFLOW_MAX_INLINE_STEPS;
  delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY;
  delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING;
  delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
  setWorld(undefined);
  spanExporter.reset();
  vi.clearAllMocks();
});

describe('background path: a queued step settling beside pending siblings', () => {
  beforeEach(() => {
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = '8';
  });
  // One inline slot: the flow delivery runs `slow` (listed first) inline and
  // queues `fast1` as a background step, then parks on `slow`'s gate.
  async function deliverQueuedStepBesideSlow(
    runId: string,
    workflowCode: string
  ) {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, workflowCode);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(
      () => {
        expect(h.stepMessageFor('fast1')).toBeDefined();
      },
      { timeout: 5_000 }
    );
    const queuedBefore = h.queued.length;
    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    return { h, slow, flow, sentByStepDelivery: h.queued.slice(queuedBefore) };
  }

  it("replays so the settled step's branch creates and runs its next step", async () => {
    const { h, slow, flow, sentByStepDelivery } =
      await deliverQueuedStepBesideSlow(newRunId(), SLOW_BESIDE_CHAIN);

    // fast2 ran to completion while slow is still parked in the flow
    // delivery, instead of waiting for slow to finish.
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.stepHas('slow', 'step_completed')).toBe(false);
    // Advance-only: the replay left slow (inline-owned by the flow delivery)
    // alone, neither re-sending a message for it nor arming a backstop.
    expect(sentByStepDelivery).toEqual([]);
    // And it replayed against a row built from the message's run identity
    // and the run's `run_created`: no read of the run per settled branch.
    expect(h.runsGet).not.toHaveBeenCalled();

    slow.open();
    await flow;
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('returns without writing or sending anything when the branch has nothing left', async () => {
    const { h, slow, flow, sentByStepDelivery } =
      await deliverQueuedStepBesideSlow(newRunId(), TWO_LEAVES);

    // fast1's own events, and nothing from the replay after it.
    expect(h.stepHas('fast1', 'step_completed')).toBe(true);
    expect(h.writtenAfterCompletionOf('fast1')).toEqual([]);
    expect(sentByStepDelivery).toEqual([]);
    expect(h.runsGet).not.toHaveBeenCalled();
    expect(hasExecutionAttribute('workflow.advance_only.idle_exit', true)).toBe(
      true
    );

    slow.open();
    await flow;
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('re-sends a never-started sibling on a redelivery, which may have created it', async () => {
    // `queued` is created and its message sent, but never picked up: the
    // shape a delivery that created it and crashed before sending would
    // leave. A first delivery leaves it; a redelivery sends it again under
    // its dispatch key, since it may be retrying exactly that delivery.
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, THREE_LEAVES);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
      expect(h.stepMessageFor('queued')).toBeDefined();
    });
    const sentBefore = h.queued.length;
    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1', 2);

    const sent = h.queued.slice(sentBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      stepId: (h.stepMessageFor('queued') as Record<string, unknown>).stepId,
    });

    slow.open();
    await h.deliver(h.stepMessageFor('queued'), 'msg_queued');
    await flow;
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('leaves a never-started sibling alone on a first delivery', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, THREE_LEAVES);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
      expect(h.stepMessageFor('queued')).toBeDefined();
    });
    const sentBefore = h.queued.length;
    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    expect(h.queued.slice(sentBefore)).toEqual([]);

    slow.open();
    await h.deliver(h.stepMessageFor('queued'), 'msg_queued');
    await flow;
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('waits for the siblings when more are pending than the bound allows', async () => {
    // One sibling pending, bound at zero: the shape of a fan-out wider than
    // the bound, whose settlements mostly have nothing after them.
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = '0';
    const { h, slow, flow, sentByStepDelivery } =
      await deliverQueuedStepBesideSlow(newRunId(), SLOW_BESIDE_CHAIN);

    expect(h.stepHas('fast2', 'step_created')).toBe(false);
    expect(sentByStepDelivery).toEqual([]);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('waits for the siblings again with the kill switch off', async () => {
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = '0';
    const { h, slow, flow } = await deliverQueuedStepBesideSlow(
      newRunId(),
      SLOW_BESIDE_CHAIN
    );

    expect(h.stepHas('fast2', 'step_created')).toBe(false);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('falls back to the unchanged wait-for-siblings path without run_created', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, SLOW_BESIDE_CHAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(
      () => {
        expect(h.stepMessageFor('fast1')).toBeDefined();
      },
      { timeout: 5_000 }
    );
    h.events.splice(
      h.events.findIndex((event) => event.eventType === 'run_created'),
      1
    );

    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    expect(h.stepHas('fast2', 'step_created')).toBe(false);

    slow.open();
    await flow;
  });

  it('converges when two queued branches replay early together', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    const a1 = gate();
    const b1 = gate();
    bodyGates.set('slow', slow);
    bodyGates.set('a1', a1);
    bodyGates.set('b1', b1);
    const h = await setupHarness(runId, TWO_CHAINS_BESIDE_SLOW);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepMessageFor('a1')).toBeDefined();
      expect(h.stepMessageFor('b1')).toBeDefined();
    });

    const first = h.deliver(h.stepMessageFor('a1'), 'msg_a1');
    const second = h.deliver(h.stepMessageFor('b1'), 'msg_b1');
    await waitFor(() => {
      expect(bodyStarts.get('a1')).toBe(1);
      expect(bodyStarts.get('b1')).toBe(1);
    });
    a1.open();
    b1.open();
    await Promise.all([first, second]);

    for (const label of ['a2', 'b2']) {
      if (!h.stepHas(label, 'step_completed')) {
        const message = h.stepMessageFor(label);
        expect(message).toBeDefined();
        await h.deliver(message, `msg_${label}`);
      }
    }

    expect(h.stepHas('a2', 'step_completed')).toBe(true);
    expect(h.stepHas('b2', 'step_completed')).toBe(true);
    expect(bodyStarts.get('a2')).toBe(1);
    expect(bodyStarts.get('b2')).toBe(1);
    slow.open();
    await flow;
  });

  it('converges when an early replay overlaps the last sibling completer', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    const fast2 = gate();
    bodyGates.set('slow', slow);
    bodyGates.set('fast2', fast2);
    const h = await setupHarness(runId, SLOW_BESIDE_CHAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(
      () => {
        expect(h.stepMessageFor('fast1')).toBeDefined();
      },
      { timeout: 5_000 }
    );

    const early = h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    await waitFor(
      () => {
        expect(bodyStarts.get('fast2')).toBe(1);
      },
      { timeout: 5_000 }
    );
    slow.open();
    await settle();
    expect(bodyStarts.get('fast2')).toBe(1);
    fast2.open();
    await Promise.all([early, flow]);
    expect(bodyStarts.get('fast2')).toBe(1);
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('does not let terminal-drain-only rows block a queued replay', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, RACE_THEN_DETACHED_TERMINAL_DRAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
    });

    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    expect(
      ['detached1', 'detached2', 'detached3', 'detached4'].some((label) =>
        h.stepHas(label, 'step_created')
      )
    ).toBe(true);
    expect(
      ['detached1', 'detached2', 'detached3', 'detached4'].every(
        (label) => !h.stepHas(label, 'step_started')
      )
    ).toBe(true);
    // The queued winner is itself an advance-only replay. It must not seal the
    // run while the inline loser still has a live executor.
    expect(h.events.map((event) => event.eventType)).not.toContain(
      'run_completed'
    );
    expect(
      h.queued.filter((message) => message.terminalBackstop === true)
    ).toHaveLength(1);

    slow.open();
    await flow;
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('guards run_failed on a queued-step advance-only replay', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, FAIL_AFTER_RACE);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
    });

    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    expect(h.events.map((event) => event.eventType)).not.toContain(
      'run_failed'
    );
    expect(
      h.queued.filter((message) => message.terminalBackstop === true)
    ).toHaveLength(1);

    slow.open();
    await flow;
    expect(h.events.map((event) => event.eventType)).toContain('run_failed');
  });

  it('dispatches overflow steps created before an in-process attribute detour', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, ATTRIBUTE_FANOUT_BESIDE_SLOW);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
    });

    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    const overflowMessages = ['next1', 'next2', 'next3']
      .map((label) => h.stepMessageFor(label))
      .filter((message) => message !== undefined);
    expect(
      overflowMessages.length,
      JSON.stringify({
        starts: Object.fromEntries(bodyStarts),
        eventTypes: h.events.map((event) => event.eventType),
        queued: h.queued.map((message) => ({
          stepId: message.stepId,
          stepName: message.stepName,
          advanceOnly: message.advanceOnly,
        })),
      })
    ).toBeGreaterThan(0);
    for (const [index, message] of overflowMessages.entries()) {
      await h.deliver(message, `msg_overflow_${index}`);
    }

    slow.open();
    await flow;
    for (const label of ['next1', 'next2', 'next3']) {
      expect(h.stepHas(label, 'step_completed')).toBe(true);
    }
  });
});

describe('inline path: an inline step settling while its batch is still running', () => {
  // Both first-round steps run inline in the flow delivery; `slow` parks.
  async function startInlineBatch(
    runId: string,
    holdSlowClaim = false,
    options: {
      invokeCapable?: boolean;
      maxConcurrencyCapable?: boolean;
    } = {}
  ) {
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, CHAIN_BESIDE_SLOW, options);
    const slowClaim = gate();
    if (holdSlowClaim) h.claimGates.set('slow', slowClaim);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await waitFor(() => {
      expect(h.stepHas('fast1', 'step_completed')).toBe(true);
    });
    return { h, slow, slowClaim, flow };
  }
  const handOffs = (h: Harness) =>
    h.queued.filter((m) => m.advanceOnly === true);
  const terminalBackstops = (h: Harness) =>
    h.queued.filter((m) => m.terminalBackstop === true);

  it.each([
    ['disabled', '0', 0, 1],
    ['enabled', '1', 1, 2],
  ] as const)('counts idle two-leaf hand-off cost with advance-only %s', async (_label, enabled, expectedSends, expectedInvocations) => {
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = enabled;
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(newRunId(), TWO_LEAVES);
    const flow = h.deliver(
      { runId: h.startMessage.runId, requestedAt: new Date() },
      'msg_flow'
    );

    if (enabled === '1') {
      await waitFor(() => {
        expect(handOffs(h)).toHaveLength(1);
      });
      await h.deliver(handOffs(h)[0], 'msg_handoff');
    } else {
      await settle();
      expect(handOffs(h)).toEqual([]);
    }

    slow.open();
    await flow;
    expect(h.queue).toHaveBeenCalledTimes(expectedSends);
    expect(h.deliveryCount()).toBe(expectedInvocations);
  });

  it('hands the settled branch to an advance-only replay that advances it', async () => {
    const runId = newRunId();
    const { h, slow, flow } = await startInlineBatch(runId);

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    const [handOff] = handOffs(h);
    // A plain continuation: no step to run, and never the start payload,
    // which would re-engage turbo on the receiving delivery.
    expect(handOff).toMatchObject({ runId, advanceOnly: true });
    expect(handOff.stepId).toBeUndefined();
    expect(handOff.runInput).toBeUndefined();
    const handOffCall = h.queue.mock.calls.find(([, message]) =>
      Object.is(message, handOff)
    );
    expect(handOffCall?.[2]?.idempotencyKey).toMatch(
      new RegExp(`^advance-only:${runId}:step_`)
    );

    const queuedBefore = h.queued.length;
    await h.deliver(handOff, 'msg_handoff');

    // The hand-off replay ran fast2 while slow is still parked in the flow
    // delivery, and left slow to it.
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.stepHas('slow', 'step_completed')).toBe(false);
    expect(h.queued.slice(queuedBefore)).toEqual([]);
    expect(hasExecutionAttribute('workflow.advance_only.ran', true)).toBe(true);

    slow.open();
    await flow;
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
    expect(
      hasExecutionAttribute('workflow.advance_only.handoff_sent', true)
    ).toBe(true);
    // The step that settled last hands nothing off: the loop replays next.
    expect(handOffs(h)).toHaveLength(1);
  });

  it('hands off only once every claim in the batch has settled', async () => {
    const { h, slow, slowClaim, flow } = await startInlineBatch(
      newRunId(),
      true
    );

    // fast1 has settled, but slow's claim response has not come back. A
    // replay woken now could see slow as unclaimed and race this delivery
    // for it.
    await settle();
    expect(handOffs(h)).toEqual([]);

    slowClaim.open();
    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });

    slow.open();
    await flow;
  });

  it('does not publish the hand-off until run_started is durable', async () => {
    const runId = newRunId();
    const runStarted = gate();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, CHAIN_BESIDE_SLOW, {
      runStartedGate: runStarted,
    });
    const flow = h.deliver(h.startMessage, 'msg_flow');

    await waitFor(() => {
      expect(bodyFinishes.has('fast1')).toBe(true);
    });
    await settle();
    expect(handOffs(h)).toEqual([]);

    runStarted.open();
    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    slow.open();
    await flow;
  });

  it('skips a hand-off when the batch settles while its durability barrier is pending', async () => {
    const runStarted = gate();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(newRunId(), CHAIN_BESIDE_SLOW, {
      runStartedGate: runStarted,
    });
    const flow = h.deliver(h.startMessage, 'msg_flow');

    await waitFor(() => {
      expect(bodyFinishes.has('fast1')).toBe(true);
    });
    slow.open();
    await waitFor(() => {
      expect(bodyFinishes.has('slow')).toBe(true);
    });
    expect(handOffs(h)).toEqual([]);

    runStarted.open();
    await flow;
    expect(handOffs(h)).toEqual([]);
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('does not publish the hand-off until sibling dispatches are durable', async () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '2';
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = '8';
    const runId = newRunId();
    const dispatch = gate();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, INLINE_BATCH_WITH_QUEUED_SIBLING, {
      stepSendGate: dispatch,
    });
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(bodyFinishes.has('fast1')).toBe(true);
    });
    await settle();
    expect(handOffs(h)).toEqual([]);

    dispatch.open();
    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
      expect(h.stepMessageFor('queued')).toBeDefined();
    });
    const queued = h.deliver(h.stepMessageFor('queued'), 'msg_queued');
    const handedOff = h.deliver(handOffs(h)[0], 'msg_handoff');
    slow.open();
    await Promise.all([flow, queued, handedOff]);
  });

  it('still advances in the batch replay when the optional hand-off send fails', async () => {
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, CHAIN_BESIDE_SLOW, {
      failAdvanceOnlySend: true,
    });
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(h.stepHas('fast1', 'step_completed')).toBe(true);
    });
    slow.open();
    await flow;

    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it("converges when a hand-off overlaps the batch's own replay", async () => {
    const runId = newRunId();
    const { h, slow, flow } = await startInlineBatch(runId);
    const fast2 = gate();
    bodyGates.set('fast2', fast2);
    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });

    const handedOff = h.deliver(handOffs(h)[0], 'msg_handoff');
    await waitFor(() => {
      expect(bodyStarts.get('fast2')).toBe(1);
    });
    slow.open();
    await settle();
    expect(bodyStarts.get('fast2')).toBe(1);
    fast2.open();
    await Promise.all([handedOff, flow]);

    expect(bodyStarts.get('fast2')).toBe(1);
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('does not let the ordinary batch replay seal the run while handed-off detached work is running', async () => {
    const runId = newRunId();
    const slow = gate();
    const detached = gate();
    bodyGates.set('slow', slow);
    bodyGates.set('detached', detached);
    const h = await setupHarness(runId, DETACHED_AFTER_FAST_BESIDE_SLOW);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    const handedOff = h.deliver(handOffs(h)[0], 'msg_handoff');
    await waitFor(() => {
      expect(bodyStarts.get('detached')).toBe(1);
    });

    slow.open();
    await flow;
    expect(h.events.map((event) => event.eventType)).not.toContain(
      'run_completed'
    );

    detached.open();
    await handedOff;
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('schedules one lease-spaced terminal safety probe while live work runs', async () => {
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, RACE_THEN_DETACHED_TERMINAL_DRAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    await h.deliver(handOffs(h)[0], 'msg_handoff');

    expect(
      ['detached1', 'detached2', 'detached3', 'detached4'].some((label) =>
        h.stepHas(label, 'step_created')
      )
    ).toBe(true);
    expect(
      ['detached1', 'detached2', 'detached3', 'detached4'].every(
        (label) => !h.stepHas(label, 'step_started')
      )
    ).toBe(true);
    expect(h.events.map((event) => event.eventType)).not.toContain(
      'run_completed'
    );
    expect(terminalBackstops(h)).toHaveLength(1);
    const backstopCall = h.queue.mock.calls.find(([, message]) =>
      Object.is(message, terminalBackstops(h)[0])
    );
    expect(backstopCall?.[2]).toMatchObject({
      delaySeconds: 860,
      idempotencyKey: `advance-only:terminal-backstop:${runId}`,
    });
    expect(terminalBackstops(h)[0]).toMatchObject({
      terminalBackstopAttempt: 0,
    });

    await expect(
      h.deliver(terminalBackstops(h)[0], 'msg_terminal_backstop')
    ).resolves.toBeUndefined();
    expect(terminalBackstops(h)).toHaveLength(1);
    expect(
      hasExecutionAttribute(
        'workflow.advance_only.terminal_backstop_attempt',
        0
      )
    ).toBe(true);

    // The live step's own handler completes the run; the safety probe never
    // becomes a duration-proportional polling loop.
    slow.open();
    await flow;
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('does not re-arm an early terminal safety probe', async () => {
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, RACE_THEN_DETACHED_TERMINAL_DRAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    await h.deliver(handOffs(h)[0], 'msg_handoff');
    expect(terminalBackstops(h)).toHaveLength(1);

    await expect(
      h.deliver(terminalBackstops(h)[0], 'msg_terminal_backstop', 48)
    ).resolves.toBeUndefined();
    expect(h.events.map((event) => event.eventType)).not.toContain(
      'run_failed'
    );
    expect(terminalBackstops(h)).toHaveLength(1);

    // A transport redelivery is also a no-op while the live owner remains.
    await h.deliver(
      terminalBackstops(h)[0],
      'msg_terminal_backstop_redelivery',
      2
    );
    expect(terminalBackstops(h)).toHaveLength(1);

    slow.open();
    await flow;
  });

  it('does not recover drain-only steps when a World drops unknown creation fields', async () => {
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, RACE_THEN_DETACHED_TERMINAL_DRAIN, {
      dropUnknownStepCreatedFields: true,
    });
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    await h.deliver(handOffs(h)[0], 'msg_handoff');
    expect(terminalBackstops(h)).toHaveLength(1);

    await h.deliver(
      terminalBackstops(h)[0],
      'msg_terminal_backstop_redelivery',
      2
    );

    const detachedLabels = ['detached1', 'detached2', 'detached3', 'detached4'];
    for (const label of detachedLabels) {
      const message = h.stepMessageFor(label);
      if (message) await h.deliver(message, `msg_${label}`);
    }
    for (const label of detachedLabels) {
      expect(bodyStarts.get(label)).toBeUndefined();
    }

    slow.open();
    await flow;
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('applies the same live-pending guard before run_failed', async () => {
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, FAIL_AFTER_RACE, {
      dropUnknownStepCreatedFields: true,
    });
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    await h.deliver(handOffs(h)[0], 'msg_handoff');
    expect(h.events.map((event) => event.eventType)).not.toContain(
      'run_failed'
    );
    expect(terminalBackstops(h)).toHaveLength(1);

    slow.open();
    await flow;
    const types = h.events.map((event) => event.eventType);
    expect(types.lastIndexOf('step_completed')).toBeLessThan(
      types.indexOf('run_failed')
    );
  });

  it('restores main detached-step completion behavior with the kill switch off', async () => {
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = '0';
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(newRunId(), DETACHED_AFTER_FAST_BESIDE_SLOW);
    const flow = h.deliver(
      { runId: h.startMessage.runId, requestedAt: new Date() },
      'msg_flow'
    );

    await waitFor(() => {
      expect(bodyFinishes.has('fast1')).toBe(true);
    });
    expect(handOffs(h)).toEqual([]);
    slow.open();
    await flow;

    expect(bodyStarts.get('detached')).toBeUndefined();
    expect(h.events.map((event) => event.eventType)).toContain('run_completed');
  });

  it('hands nothing off when more are pending than the bound allows', async () => {
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = '0';
    const { h, slow, flow } = await startInlineBatch(newRunId());

    await settle();
    expect(handOffs(h)).toEqual([]);
    expect(h.stepHas('fast2', 'step_created')).toBe(false);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
  });

  it('hands nothing off with the kill switch off', async () => {
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = '0';
    const { h, slow, flow } = await startInlineBatch(newRunId());

    await settle();
    expect(handOffs(h)).toEqual([]);
    expect(h.stepHas('fast2', 'step_created')).toBe(false);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('hands nothing off on an invoke-capable World', async () => {
    const { h, slow, flow } = await startInlineBatch(newRunId(), false, {
      invokeCapable: true,
    });

    await settle();
    expect(handOffs(h)).toEqual([]);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('does not dispatch an early retry on an invoke-capable World', async () => {
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    bodyFailuresRemaining.set('retry', 1);
    const h = await setupHarness(runId, RETRY_BESIDE_SLOW, {
      invokeCapable: true,
    });
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');

    await waitFor(() => {
      expect(h.stepHas('retry', 'step_retrying')).toBe(true);
    });
    await settle();
    expect(h.stepMessageFor('retry')).toBeUndefined();

    slow.open();
    await flow;
    expect(h.stepMessageFor('retry')).toBeDefined();
  });

  it('does not infer serialized replays from an unverifiable runtime setting', async () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';
    const { h, slow, flow } = await startInlineBatch(newRunId(), false, {
      maxConcurrencyCapable: true,
    });

    await waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    slow.open();
    await flow;
  });
});
