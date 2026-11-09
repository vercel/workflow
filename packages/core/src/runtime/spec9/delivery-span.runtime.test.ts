import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { type Event, SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
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
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// The `workflow.execute` span says which orchestrator ran a delivery, how the
// queue counted it, and why a delivery ended early.

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

beforeEach(() => {
  spanExporter.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Moves `Date.now()` past every invocation deadline while a body runs. */
let clockOffsetMs = 0;
const realNow = Date.now.bind(Date);
registerStepFunction('span_add', async (a: number, b: number) => a + b);
registerStepFunction('span_slow_add', async (a: number, b: number) => {
  clockOffsetMs += 30 * 60_000;
  return a + b;
});

const key = (attribute: Record<string, unknown>) => Object.keys(attribute)[0]!;
const SPEC_VERSION = key(Attribute.WorkflowRunSpecVersion(0));
const ATTEMPT = key(Attribute.WorkflowDeliveryAttempt(0));
const DELIVERY_COUNT = key(Attribute.WorkflowDeliveryCount(0));
const EXIT_REASON = key(Attribute.WorkflowDeliveryExitReason(''));
const HANDOFF = key(Attribute.WorkflowDeliveryHandoff(false));

const executeSpans = (): ReadableSpan[] =>
  spanExporter
    .getFinishedSpans()
    .filter((span) => span.name.startsWith('workflow.execute'));

describe('workflow.execute span', () => {
  it('records the spec version and the queue counts of a delivery', async () => {
    const { world, start } = await setupOrchestratorRun(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_add");
       async function workflow(a, b) { return await add(a, b); }${registerWorkflow()}`,
      [1, 2]
    );
    await world.deliver(start);

    const [span] = executeSpans();
    expect(span?.attributes[SPEC_VERSION]).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    expect(span?.attributes[ATTEMPT]).toBe(1);
    expect(span?.attributes[DELIVERY_COUNT]).toBe(1);
    expect(span?.attributes[EXIT_REASON]).toBeUndefined();
    expect(span?.attributes[HANDOFF]).toBeUndefined();
    // The start message carries no spec version, so routing read the run.
    expect(
      spanExporter
        .getFinishedSpans()
        .filter((s) => s.name === 'workflow.route.resolve_spec')
    ).toHaveLength(1);
  });

  it('records a deadline handoff, and the handed-off delivery counts', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
    const { world, start } = await setupOrchestratorRun(
      `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_slow_add");
       const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_add");
       async function workflow(a, b) {
         const first = await slow(a, b);
         return await add(first, 10);
       }${registerWorkflow()}`,
      [1, 2]
    );
    clockOffsetMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs);
    expect(await world.deliver(start)).toEqual({ timeoutSeconds: 0 });
    vi.restoreAllMocks();
    const [handedOff] = world.held;
    expect(handedOff).toBeDefined();
    await world.deliver(handedOff!);

    const [first, second] = executeSpans();
    expect(first?.attributes[EXIT_REASON]).toBe('deadline');
    expect(first?.attributes[HANDOFF]).toBe(true);
    // A handoff advances deliveryCount and leaves attempt.
    expect(second?.attributes[ATTEMPT]).toBe(1);
    expect(second?.attributes[DELIVERY_COUNT]).toBe(2);
  });
});

// QuickJS run-ahead telemetry: the delivery's `workflow.execute` span carries
// the run-ahead counters, and a stop's restart in place names itself as the
// delivery's exit reason.
describe('workflow.execute span, QuickJS run-ahead', () => {
  const RA_STEPS = 6;
  const loop = (
    prelude: string
  ) => `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_add");
    const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow(steps) {
      ${prelude}
      let n = 0;
      for (let i = 0; i < steps; i++) n = await add(n, 1);
      return n;
    }${registerWorkflow()}`;
  /** Holds each `step_completed` back, as a remote World's round trip does. */
  const slowOutcomes = async (data: { eventType: string }) => {
    if (data.eventType === 'step_completed') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('VERCEL_URL', 'span.example.test');
  });

  it('records the depth and the boundaries it ran ahead at, with no stop', async () => {
    const { world, start } = await setupOrchestratorRun(
      loop(''),
      [RA_STEPS],
      { beforeCreate: slowOutcomes },
      'quickjs'
    );
    await world.deliver(start);
    expect(await runResult(world)).toBe(RA_STEPS);

    const [span] = executeSpans();
    expect(span?.attributes['workflow.run_ahead.depth']).toBe(10);
    expect(span?.attributes['workflow.run_ahead.boundaries']).toBeGreaterThan(
      0
    );
    expect(span?.attributes['workflow.run_ahead.hazard_stops']).toBe(0);
    expect(span?.attributes['workflow.run_ahead.failure_stops']).toBe(0);
    expect(span?.attributes['workflow.run_ahead.repairs']).toBe(0);
    expect(span?.attributes[EXIT_REASON]).toBeUndefined();
    expect(span?.status.code).not.toBe(2);
  });

  it('records a displaced write and the restart in place it ends in', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '2');
    let injected = false;
    let outcomes = 0;
    let world!: AppendOnlyWorld;
    let runId!: string;
    ({ world, runId } = await setupOrchestratorRun(
      loop('const hook = createHook({ token: "span-unobserved" });'),
      [RA_STEPS],
      {
        async beforeCreate(data) {
          await slowOutcomes(data);
          if (
            injected ||
            data.eventType !== 'step_completed' ||
            ++outcomes !== 2
          ) {
            return;
          }
          injected = true;
          world.appendOutOfBand({
            eventType: 'hook_received',
            runId,
            correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
            eventData: {
              token: 'span-unobserved',
              payload: await dehydrateStepReturnValue('late', runId, undefined),
            },
          } as unknown as Partial<Event>);
        },
      },
      'quickjs'
    ));
    await world.deliver(world.held[0]!);
    expect(injected).toBe(true);
    expect(await runResult(world)).toBe(RA_STEPS);

    const [span] = executeSpans();
    expect(span?.attributes['workflow.run_ahead.repairs']).toBe(1);
    expect(span?.attributes['workflow.run_ahead.hazard_stops']).toBe(0);
    expect(span?.attributes[EXIT_REASON]).toBe('run-ahead-restart');
    // Continued in this delivery, not handed to the next.
    expect(span?.attributes[HANDOFF]).toBe(false);
    expect(span?.status.code).not.toBe(2);
  });

  it('records a hazard stop and the restart in place it ends in', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '2');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(runtimeLogger, 'info');
    let injected = false;
    let world!: AppendOnlyWorld;
    let runId!: string;
    ({ world, runId } = await setupOrchestratorRun(
      loop('const timer = sleep("1h");'),
      [RA_STEPS],
      {
        async beforeCreate(data, _params, source) {
          await slowOutcomes(data);
          if (injected || data.eventType !== 'step_completed' || !source?.batch)
            return;
          injected = true;
          // Another writer completes the far-future sleep: a hazard below
          // whatever ran ahead.
          world.appendOutOfBand({
            eventType: 'wait_completed',
            runId,
            correlationId: eventsOf(world, 'wait_created')[0]?.correlationId,
            eventData: {},
          } as unknown as Partial<Event>);
        },
      },
      'quickjs'
    ));
    await world.deliver(world.held[0]!);
    expect(injected).toBe(true);
    expect(await runResult(world)).toBe(RA_STEPS);
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes('continuing in place')
      )
    ).toBe(true);

    const [span] = executeSpans();
    expect(span?.attributes['workflow.run_ahead.hazard_stops']).toBe(1);
    expect(span?.attributes[EXIT_REASON]).toBe('run-ahead-restart');
    expect(span?.status.code).not.toBe(2);
  });
});

describe('workflow.execute span, node run-ahead', () => {
  // Long enough that a context kept per boundary would show: the old hazard
  // check kept one for every boundary since the last drain, and a sequential
  // run of inert boundaries never drains.
  const STEPS = 60;
  const loop = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("span_add");
    async function workflow(steps) {
      let n = 0;
      for (let i = 0; i < steps; i++) n = await add(n, 1);
      return n;
    }${registerWorkflow()}`;

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('VERCEL_URL', 'span.example.test');
  });

  it('holds the run-ahead contexts of the writes in flight only, however many steps ran ahead', async () => {
    const { world, start } = await setupOrchestratorRun(
      loop,
      [STEPS],
      {
        // Each outcome takes a round trip, so speculative writes are in
        // flight while the next steps run ahead, and the live feed's echoes
        // and the write reports reach the hazard check.
        subscribe: true,
        async beforeCreate(data) {
          if (data.eventType === 'step_completed') {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      },
      'node'
    );
    await world.deliver(start);
    expect(await runResult(world)).toBe(STEPS);

    const [span] = executeSpans();
    const depth = span?.attributes['workflow.run_ahead.depth'] as number;
    expect(depth).toBe(10);
    // Every boundary of the loop ran ahead and none drained.
    expect(span?.attributes['workflow.run_ahead.boundaries']).toBe(STEPS);
    expect(span?.attributes['workflow.run_ahead.drained_boundaries']).toBe(0);
    expect(span?.attributes['workflow.run_ahead.hazard_stops']).toBe(0);
    // At most one context per speculative write in flight: the creation and
    // the outcomes within the depth, never one per step the loop ran.
    const contextsMax = span?.attributes[
      'workflow.run_ahead.contexts_max'
    ] as number;
    expect(contextsMax).toBeGreaterThan(0);
    expect(contextsMax).toBeLessThanOrEqual(depth + 1);
  });
});
