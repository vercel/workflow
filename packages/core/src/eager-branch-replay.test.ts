/**
 * vercel/workflow#4457: a parallel branch whose step settles advances without
 * waiting for the steps still pending beside it, on both the queued-step
 * (background) path and the inline path. See `isEagerBranchReplayEnabled`.
 *
 * Each test drives the real entrypoint against an in-memory World whose step
 * bodies park on gates, so a sibling can be held in flight while another
 * branch's step settles.
 */
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from './logger.js';
import { registerStepFunction } from './private.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepArguments,
} from './serialization.js';

type Gate = { promise: Promise<void>; open: () => void };
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
registerStepFunction('branchStep', async (label: string) => {
  await bodyGates.get(label)?.promise;
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

interface Harness {
  deliver: (
    message: unknown,
    messageId: string,
    attempt?: number
  ) => Promise<unknown>;
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
}

async function setupHarness(
  runId: string,
  workflowCode: string
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

  const create = vi.fn(async (_runId: string, data: any) => {
    if (data.eventType === 'run_started') {
      return { run: workflowRun, events: [...events] };
    }
    if (data.eventType === 'step_created') {
      await learnLabel(data.correlationId, data.eventData?.input);
      return { event: record(data) };
    }
    if (data.eventType === 'step_started') {
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
    }
    return { event: record(data) };
  });

  const queued: Array<Record<string, unknown>> = [];
  const runsGet = vi.fn(async () => workflowRun);
  let handler!: (message: unknown, metadata: unknown) => Promise<unknown>;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
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
    queue: vi.fn(async (_queueName: string, message: any) => {
      queued.push(message);
      return { messageId: null };
    }),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);
  await workflowEntrypoint(workflowCode)(new Request('https://example.test'));

  const isStep = (e: Event, label: string, eventType: string) =>
    e.eventType === eventType &&
    e.correlationId !== undefined &&
    labels.get(e.correlationId) === label;

  return {
    deliver: (message, messageId, attempt = 1) =>
      handler(message, {
        requestId: `req_${messageId}`,
        attempt,
        queueName: '__wkf_workflow_workflow',
        messageId,
      }),
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

// Every test but the grace-delay ones advances at once, so each can watch one
// gate at a time without the delay standing in front of it.
beforeEach(() => {
  process.env.WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS = '0';
});

afterEach(() => {
  bodyGates.clear();
  delete process.env.WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS;
  delete process.env.WORKFLOW_MAX_INLINE_STEPS;
  delete process.env.WORKFLOW_EAGER_BRANCH_REPLAY;
  delete process.env.WORKFLOW_EAGER_BRANCH_REPLAY_MAX_PENDING;
  setWorld(undefined);
  vi.clearAllMocks();
});

describe('background path: a queued step settling beside pending siblings', () => {
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
    await vi.waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
    });
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY_MAX_PENDING = '0';
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
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY = '0';
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
});

describe('inline path: an inline step settling while its batch is still running', () => {
  // Both first-round steps run inline in the flow delivery; `slow` parks.
  async function startInlineBatch(runId: string, holdSlowClaim = false) {
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, CHAIN_BESIDE_SLOW);
    const slowClaim = gate();
    if (holdSlowClaim) h.claimGates.set('slow', slowClaim);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await vi.waitFor(() => {
      expect(h.stepHas('fast1', 'step_completed')).toBe(true);
    });
    return { h, slow, slowClaim, flow };
  }
  const handOffs = (h: Harness) =>
    h.queued.filter((m) => m.advanceOnly === true);

  it('hands the settled branch to an advance-only replay that advances it', async () => {
    const runId = newRunId();
    const { h, slow, flow } = await startInlineBatch(runId);

    await vi.waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });
    const [handOff] = handOffs(h);
    // A plain continuation: no step to run, and never the start payload,
    // which would re-engage turbo on the receiving delivery.
    expect(handOff).toMatchObject({ runId, advanceOnly: true });
    expect(handOff.stepId).toBeUndefined();
    expect(handOff.runInput).toBeUndefined();

    const queuedBefore = h.queued.length;
    await h.deliver(handOff, 'msg_handoff');

    // The hand-off replay ran fast2 while slow is still parked in the flow
    // delivery, and left slow to it.
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.stepHas('slow', 'step_completed')).toBe(false);
    expect(h.queued.slice(queuedBefore)).toEqual([]);

    slow.open();
    await flow;
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
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
    await vi.waitFor(() => {
      expect(handOffs(h)).toHaveLength(1);
    });

    slow.open();
    await flow;
  });

  it('hands nothing off when more are pending than the bound allows', async () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY_MAX_PENDING = '0';
    const { h, slow, flow } = await startInlineBatch(newRunId());

    await settle();
    expect(handOffs(h)).toEqual([]);
    expect(h.stepHas('fast2', 'step_created')).toBe(false);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
  });

  it('hands nothing off with the kill switch off', async () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY = '0';
    const { h, slow, flow } = await startInlineBatch(newRunId());

    await settle();
    expect(handOffs(h)).toEqual([]);
    expect(h.stepHas('fast2', 'step_created')).toBe(false);

    slow.open();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });
});

describe('grace delay: siblings that settle soon get one replay between them', () => {
  const GRACE_MS = 300;

  it('a queued step leaves the replay to a sibling that settles within the delay', async () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS = String(GRACE_MS);
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, SLOW_BESIDE_CHAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await vi.waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
    });

    // slow settles well inside fast1's grace delay.
    setTimeout(slow.open, GRACE_MS / 6);
    const debug = vi.spyOn(runtimeLogger, 'debug');
    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');

    // The step delivery saw nothing pending after the delay and left the
    // replay to the flow delivery, which settled slow last.
    const messages = debug.mock.calls.map(([message]) => message);
    expect(messages).toContain(
      'Background step done and its siblings settled within the grace delay, returning'
    );
    expect(messages).not.toContain(
      'Background step done with other steps pending, replaying advance-only'
    );
    debug.mockRestore();
    await flow;
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('a queued step replays early once the delay passes with a sibling still running', async () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS = String(GRACE_MS);
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, SLOW_BESIDE_CHAIN);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await vi.waitFor(() => {
      expect(h.stepMessageFor('fast1')).toBeDefined();
    });

    const startedAt = Date.now();
    await h.deliver(h.stepMessageFor('fast1'), 'msg_fast1');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(GRACE_MS - 20);
    expect(h.stepHas('fast2', 'step_completed')).toBe(true);
    expect(h.stepHas('slow', 'step_completed')).toBe(false);

    slow.open();
    await flow;
  });

  it('an inline batch that settles within the delay hands nothing off', async () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS = String(GRACE_MS);
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, CHAIN_BESIDE_SLOW);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await vi.waitFor(() => {
      expect(h.stepHas('fast1', 'step_completed')).toBe(true);
    });
    setTimeout(slow.open, GRACE_MS / 6);
    await flow;

    expect(h.queued.filter((m) => m.advanceOnly === true)).toEqual([]);
    expect(h.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('an inline batch still running after the delay hands the settled branch off', async () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS = String(GRACE_MS);
    const runId = newRunId();
    const slow = gate();
    bodyGates.set('slow', slow);
    const h = await setupHarness(runId, CHAIN_BESIDE_SLOW);
    const flow = h.deliver({ runId, requestedAt: new Date() }, 'msg_flow');
    await vi.waitFor(() => {
      expect(h.stepHas('fast1', 'step_completed')).toBe(true);
    });
    const settledAt = Date.now();
    await vi.waitFor(
      () => {
        expect(h.queued.filter((m) => m.advanceOnly === true)).toHaveLength(1);
      },
      { timeout: GRACE_MS * 5 }
    );
    expect(Date.now() - settledAt).toBeGreaterThanOrEqual(GRACE_MS - 20);

    slow.open();
    await flow;
  });
});
