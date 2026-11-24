import { AsyncLocalStorage } from 'node:async_hooks';
import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ReplayDivergenceError, WorkflowWorldError } from '@workflow/errors';
import type { Event } from '@workflow/world';
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
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import { setAttributes } from '../../set-attributes.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import type { WorkflowSession } from '../../workflow.js';
import { wakeUpRun } from '../runs.js';
import { getWorld } from '../world.js';
import { parkSession, takeParkedSession } from './parked-session.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// Cold replays: a fresh VM over the whole log. A resumed parked VM is none,
// and a resume the VM declines falls back to one. Resumes: a retained or
// parked VM advanced on more of the log, user code included.
const { coldReplays, resumes } = vi.hoisted(() => ({
  coldReplays: { count: 0 },
  resumes: { count: 0 },
}));
vi.mock('../../workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workflow.js')>();
  return {
    ...actual,
    replayWorkflow: (...args: Parameters<typeof actual.replayWorkflow>) => {
      coldReplays.count++;
      return actual.replayWorkflow(...args);
    },
    resumeWorkflow: (...args: Parameters<typeof actual.resumeWorkflow>) => {
      resumes.count++;
      return actual.resumeWorkflow(...args);
    },
  };
});

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

const key = (attribute: Record<string, unknown>) => Object.keys(attribute)[0]!;
const SKIP_REASON = key(Attribute.WorkflowParkedSessionSkipReason('disabled'));
const READ = key(Attribute.WorkflowParkedSessionRead('resume'));
const DIVERGED = key(Attribute.WorkflowParkedSessionDiverged(true));

/** Every value the finished spans carry for `attribute`, in finish order. */
const spanValues = (attribute: string): unknown[] =>
  spanExporter
    .getFinishedSpans()
    .map((span) => span.attributes[attribute])
    .filter((value) => value !== undefined);

// A session-style workflow: one inline step per hook payload. Each payload
// arrives after the delivery that handled the previous one acknowledged, as
// a message does once its orchestrator stopped lingering.

const TOKEN = 'parked-session-hook';
/** The payloads `ps_echo` bodies ran on. */
let echoBodies: string[] = [];
let echoes = 0;
registerStepFunction('ps_echo', async (payload: string) => {
  echoes++;
  echoBodies.push(payload);
  return `echo:${payload}`;
});

const sessionWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const replies = [];
    for await (const payload of hook) {
      replies.push(await echo(payload));
      if (replies.length === 3) break;
    }
    return replies;
  }${registerWorkflow()}`;

// Ends with a step it never awaits, which the end-of-run drain records.
const unawaitedTailWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const replies = [];
    for await (const payload of hook) {
      replies.push(await echo(payload));
      if (replies.length === 2) break;
    }
    echo("tail");
    return replies;
  }${registerWorkflow()}`;

// A step body that sets an attribute writes an `attr_set` the delivery did
// not write, which takes the slot the step's speculative outcome was placed
// at.
let attributeSets = 0;
registerStepFunction('ps_echo_attr', async (payload: string) => {
  attributeSets++;
  await setAttributes({ last: payload });
  return `echo:${payload}`;
});
const attributeSessionWorkflow = sessionWorkflow.replace(
  '"ps_echo"',
  '"ps_echo_attr"'
);

registerStepFunction('ps_inc', async (n: number) => n + 1);

// An open hook the workflow never awaits, beside a loop of inline steps that
// runs ahead, then the session's hook loop.
const displacingWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const inc = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_inc");
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const side = createHook({ token: "ps-side" });
    let n = 0;
    for (let i = 0; i < 6; i++) n = await inc(n);
    const replies = [];
    for await (const payload of hook) {
      replies.push(await echo(payload));
      if (replies.length === 2) break;
    }
    return { n, replies };
  }${registerWorkflow()}`;

/** Full loads: an ascending read of the log from its start. */
const fullLoadsOf = (world: AppendOnlyWorld) =>
  world.listCalls.filter((call) => {
    const pagination = call.pagination as
      | { cursor?: string; sortOrder?: string }
      | undefined;
    return pagination?.cursor === undefined && pagination?.sortOrder === 'asc';
  }).length;

async function send(world: AppendOnlyWorld, runId: string, payload: string) {
  world.appendOutOfBand({
    eventType: 'hook_received',
    runId,
    correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
    eventData: {
      token: TOKEN,
      payload: await dehydrateStepReturnValue(payload, runId, undefined),
    },
  } as unknown as Partial<Event>);
  // The unkeyed wake `resumeHook()` sends once its event committed.
  return world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
}

beforeEach(() => {
  echoes = 0;
  attributeSets = 0;
  coldReplays.count = 0;
  resumes.count = 0;
  spanExporter.reset();
  // Parking is opt-in.
  vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', String(8 * 1024 * 1024));
  // No linger, so every payload reaches a new delivery.
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a session parked across deliveries', () => {
  it('resumes the parked VM on what landed since, without a full load', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);
    const startReplays = coldReplays.count;
    // The count sees the start delivery's replay.
    expect(startReplays).toBeGreaterThan(0);

    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(startLoads);
    expect(coldReplays.count).toBe(startReplays);
  });

  it("records what the resumed VM left queued through the resuming delivery's writer", async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      unawaitedTailWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);
    const startReplays = coldReplays.count;
    for (const payload of ['a', 'b']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b']);
    // The run finished on a resumed VM, not a cold replay.
    expect(fullLoadsOf(world)).toBe(startLoads);
    expect(coldReplays.count).toBe(startReplays);
    // Inline steps record no `step_created`; the unawaited one is the drain's.
    expect(eventsOf(world, 'step_created')).toHaveLength(1);
  });

  it('parks and resumes a session whose step bodies set attributes', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      attributeSessionWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);
    const startReplays = coldReplays.count;
    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(attributeSets).toBe(3);
    expect(eventsOf(world, 'attr_set')).toHaveLength(3);
    // Every delivery parked its VM.
    expect(spanValues(SKIP_REASON)).toEqual([]);
    expect(fullLoadsOf(world)).toBe(startLoads);
    expect(coldReplays.count).toBe(startReplays);
  });

  // Another writer's payload takes the slot the VM consumed a speculative
  // outcome at, mid-loop, so the session continues rebased onto the ids its
  // writes committed at, parks, and is resumed through that rebase.
  it('parks and resumes a session rebased over displaced speculative writes', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '2');
    let injected = false;
    let outcomes = 0;
    let world!: AppendOnlyWorld;
    let runId = '';
    const setup = await setupOrchestratorRun(displacingWorkflow, [], {
      async beforeCreate(data) {
        if (data.eventType !== 'step_completed') return;
        // A remote World's round trip, so outcomes run ahead of commits.
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!injected && ++outcomes === 2) {
          injected = true;
          world.appendOutOfBand({
            eventType: 'hook_received',
            runId,
            correlationId: eventsOf(world, 'hook_created')[1]?.correlationId,
            eventData: {
              token: 'ps-side',
              payload: await dehydrateStepReturnValue('late', runId, undefined),
            },
          } as unknown as Partial<Event>);
        }
      },
    });
    world = setup.world;
    runId = setup.runId;
    await world.deliver(setup.start);
    expect(injected).toBe(true);
    const thisProcess = await getWorld();
    const entry = takeParkedSession(thisProcess, runId);
    expect(entry).toBeDefined();
    expect(entry!.session.rebased).toBe(true);
    expect(entry!.session.displacedWrites).toBe(true);
    parkSession(thisProcess, runId, entry!);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;

    for (const payload of ['a', 'b']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual({
      n: 6,
      replies: ['echo:a', 'echo:b'],
    });
    expect(spanValues(SKIP_REASON)).toEqual([]);
    expect(fullLoadsOf(world)).toBe(loads);
    expect(coldReplays.count).toBe(replays);
  });

  it('resumes a stale parked VM over the events another orchestrator wrote', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    // Another process handles 'b': it has no parked VM, so it loads the
    // whole log, and this process's VM falls behind the run's in-band count.
    const thisProcess = await getWorld();
    const stale = takeParkedSession(thisProcess, runId);
    expect(stale).toBeDefined();
    await send(world, runId, 'b');
    takeParkedSession(thisProcess, runId);
    parkSession(thisProcess, runId, stale!);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;

    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(loads);
    // The stale VM itself carried the run, not a cold replay of the log.
    expect(coldReplays.count).toBe(replays);
  });

  it("replays a parked VM that diverges from cold, without spending the log's divergence budget", async () => {
    // A divergence the delivery counted would fail the run on the spot.
    vi.stubEnv('WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES', '0');
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    const thisProcess = await getWorld();
    const parked = takeParkedSession(thisProcess, runId);
    expect(parked).toBeDefined();
    const diverging: WorkflowSession = {
      workflowRun: parked!.session.workflowRun,
      argumentCount: parked!.session.argumentCount,
      rebased: false,
      displacedWrites: false,
      resume: async () => {
        throw new ReplayDivergenceError('parked VM disagrees', {
          eventId: 'evnt_parked',
        });
      },
    };
    parkSession(thisProcess, runId, { ...parked!, session: diverging });
    const replays = coldReplays.count;

    await send(world, runId, 'b');
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    // The cold replay that replaced the VM.
    expect(coldReplays.count).toBe(replays + 1);
  });

  it('replays the log a refused cursor read from the start without reading it again', async () => {
    let refuseCursor = false;
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      [],
      {
        beforeList(params) {
          if (refuseCursor && params.pagination?.cursor !== undefined) {
            refuseCursor = false;
            throw new WorkflowWorldError('cursor expired', { status: 400 });
          }
        },
      }
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    const loads = fullLoadsOf(world);
    refuseCursor = true;

    await send(world, runId, 'b');
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    // The refused read's retry from the start is the only full load.
    expect(fullLoadsOf(world)).toBe(loads + 1);
  });

  it('is never resumed by a second delivery', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const startLoads = fullLoadsOf(world);
    await send(world, runId, 'a');
    // A wake with nothing new acknowledges and leaves the VM parked.
    await world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
    await send(world, runId, 'b');
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(startLoads);
  });

  it('reads the run only once a wake naming an event the VM consumed turns out to resume', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    const runsGet = vi.spyOn((await getWorld()).runs, 'get');
    // The queued copy of the wake 'a' already resumed the VM on, stamped
    // with the run's spec as a wake is, so routing reads no run either.
    const consumed = eventsOf(world, 'hook_received')[0]!.eventId;
    await world.deliver(
      world.enqueue(ORCHESTRATOR_QUEUE, {
        runId,
        runSpecVersion: 9,
        wakeEventId: consumed,
      })
    );
    expect(runsGet).not.toHaveBeenCalled();
    // A wake that names nothing reads the run beside the log.
    await world.deliver(
      world.enqueue(ORCHESTRATOR_QUEUE, { runId, runSpecVersion: 9 })
    );
    expect(runsGet).toHaveBeenCalledTimes(1);
    const loads = fullLoadsOf(world);
    // A payload lands before the old wake's copy arrives: the read finds it,
    // and the run is read after the read to resume on it.
    world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue('b', runId, undefined),
      },
    } as unknown as Partial<Event>);
    await world.deliver(
      world.enqueue(ORCHESTRATOR_QUEUE, {
        runId,
        runSpecVersion: 9,
        wakeEventId: consumed,
      })
    );
    expect(runsGet).toHaveBeenCalledTimes(2);
    expect(echoes).toBe(2);
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(loads);
    runsGet.mockRestore();
  });

  it('keeps no VM on the QuickJS engine', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      [],
      {},
      'quickjs'
    );
    await world.deliver(start);
    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
  });
});

describe('deliveries that bypass or drop a parked VM', () => {
  it('does a full load on a wakeUp() delivery instead of resuming the parked VM', async () => {
    const workflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
      async function workflow() {
        const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
        const wait = sleep("1h");
        const replies = [];
        for await (const payload of hook) {
          replies.push(await echo(payload));
          if (replies.length === 3) break;
        }
        await wait;
        return replies;
      }${registerWorkflow()}`;
    const { world, runId, start } = await setupOrchestratorRun(workflow, []);
    await world.deliver(start);
    expect(eventsOf(world, 'wait_created')).toHaveLength(1);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;

    expect(await wakeUpRun(world.asWorld(), runId)).toEqual({
      stoppedCount: 1,
    });
    const wake = world.held.find(
      (held) => (held.message as { completeWaits?: string[] }).completeWaits
    );
    expect(wake).toBeDefined();
    await world.deliver(wake!);
    const wakeLoads = fullLoadsOf(world);
    const wakeReplays = coldReplays.count;
    expect(wakeLoads).toBeGreaterThan(loads);
    expect(wakeReplays).toBeGreaterThan(replays);

    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(wakeLoads);
    expect(coldReplays.count).toBe(wakeReplays);
  });

  it('resumes over a hook_received for a disposed hook and ignores it', async () => {
    const workflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
      async function workflow() {
        const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
        const disposed = createHook({ token: "ps-disposed" });
        disposed.dispose();
        const replies = [];
        for await (const payload of hook) {
          replies.push(await echo(payload));
          if (replies.length === 3) break;
        }
        return replies;
      }${registerWorkflow()}`;
    const { world, runId, start } = await setupOrchestratorRun(workflow, []);
    await world.deliver(start);
    expect(eventsOf(world, 'hook_disposed')).toHaveLength(1);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;
    world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_disposed')[0]?.correlationId,
      eventData: {
        token: 'ps-disposed',
        payload: await dehydrateStepReturnValue('ignored', runId, undefined),
      },
    } as unknown as Partial<Event>);
    await world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));
    expect(echoes).toBe(0);
    expect(fullLoadsOf(world)).toBe(loads);
    expect(coldReplays.count).toBe(replays);

    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);
    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(loads);
    expect(coldReplays.count).toBe(replays);
  });

  it('does not execute a pending hook payload when a parked run is cancelled', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;
    world.appendOutOfBand({
      eventType: 'run_cancelled',
      runId,
    } as Partial<Event>);

    await send(world, runId, 'cancelled');

    expect(eventsOf(world, 'run_cancelled')).toHaveLength(1);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
    expect(await runResult(world)).toBeUndefined();
    expect(echoes).toBe(0);
    expect(fullLoadsOf(world)).toBe(loads);
    expect(coldReplays.count).toBe(replays);
    // The delivery saw the cancellation in its read and never handed the
    // payload to the VM.
    expect(resumes.count).toBe(0);
  });

  it('cold replays every follow-up when the parked VM budget is disabled', async () => {
    vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', '0');
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;
    for (const payload of ['a', 'b', 'c']) await send(world, runId, payload);

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(loads + 3);
    expect(coldReplays.count).toBe(replays + 3);
  });

  it('cold replays when a payload makes the parked VM exceed half the byte budget', async () => {
    vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', String(600 * 1024));
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    const payload = 'x'.repeat(200 * 1024);
    await send(world, runId, payload);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;
    await send(world, runId, 'b');
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual([
      `echo:${payload}`,
      'echo:b',
      'echo:c',
    ]);
    expect(echoes).toBe(3);
    expect(fullLoadsOf(world)).toBe(loads + 2);
    expect(coldReplays.count).toBe(replays + 2);
  });
});

describe('deliveries that drop or decline a parked VM', () => {
  it('drops the parked VM on a timer wake, which loads and replays the whole log itself', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const workflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
        const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
        const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
        async function workflow() {
          const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
          let woke = false;
          sleep("1s").then(() => { woke = true; });
          const replies = [];
          for await (const payload of hook) {
            replies.push(await echo(woke ? payload + ":woke" : payload));
            if (replies.length === 3) break;
          }
          return replies;
        }${registerWorkflow()}`;
      const { world, runId, start } = await setupOrchestratorRun(workflow, []);
      await world.deliver(start);
      const timer = world.held.find(
        (held) =>
          (held.message as { waitContinuation?: unknown }).waitContinuation !==
          undefined
      );
      expect(timer).toBeDefined();
      await send(world, runId, 'a');
      const loads = fullLoadsOf(world);
      const replays = coldReplays.count;
      spanExporter.reset();

      vi.setSystemTime(Date.now() + 2_000);
      await world.deliver(timer!);
      expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
      // The timer took the VM 'a' parked and dropped it.
      expect(spanValues(READ)).toEqual(['dropped']);
      expect(fullLoadsOf(world)).toBe(loads + 1);
      expect(coldReplays.count).toBe(replays + 1);

      // The timer's own replay parked, so the follow-ups resume that VM.
      await send(world, runId, 'b');
      await send(world, runId, 'c');
      expect(await runResult(world)).toEqual([
        'echo:a',
        'echo:b:woke',
        'echo:c:woke',
      ]);
      expect(fullLoadsOf(world)).toBe(loads + 1);
      expect(coldReplays.count).toBe(replays + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays from cold when the parked VM declines its resume, and the run finishes', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    // A log that does not extend what the VM consumed sends it to `replay`,
    // after which it declines every resume.
    const thisProcess = await getWorld();
    const entry = takeParkedSession(thisProcess, runId);
    expect(entry).toBeDefined();
    expect(await entry!.session.resume([])).toEqual({ type: 'replay' });
    parkSession(thisProcess, runId, entry!);
    const loads = fullLoadsOf(world);
    const replays = coldReplays.count;

    await send(world, runId, 'b');
    // The delivery read on from the cursor and replayed that log from cold.
    expect(spanValues(READ)).toContain('resume');
    expect(fullLoadsOf(world)).toBe(loads);
    expect(coldReplays.count).toBe(replays + 1);
    await send(world, runId, 'c');

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b', 'echo:c']);
    expect(echoes).toBe(3);
    // 'c' resumed the VM the cold replay parked.
    expect(coldReplays.count).toBe(replays + 1);
  });
});

describe("a resumed VM in the resuming delivery's async context", () => {
  it('drains the end-of-run queue in the store of the delivery that resumed it', async () => {
    const store = new AsyncLocalStorage<string>();
    const createdIn: (string | undefined)[] = [];
    const { world, runId, start } = await setupOrchestratorRun(
      unawaitedTailWorkflow,
      [],
      {
        async beforeCreate(data) {
          if (data.eventType === 'step_created') {
            createdIn.push(store.getStore());
          }
        },
      }
    );
    await store.run('parking', () => world.deliver(start));
    await store.run('resume-a', () => send(world, runId, 'a'));
    const replays = coldReplays.count;
    await store.run('resume-b', () => send(world, runId, 'b'));

    expect(await runResult(world)).toEqual(['echo:a', 'echo:b']);
    // The run finished on the VM the start delivery created.
    expect(coldReplays.count).toBe(replays);
    // The unawaited tail step, recorded by the drain.
    expect(createdIn).toEqual(['resume-b']);
  });
});

// The same session, deployed again: from its second payload on, a payload
// goes to another step. A VM of the first version that replays the second's
// decisions diverges where they differ; a cold replay of either log on the
// second version does not.
let shouts = 0;
registerStepFunction('ps_shout', async (payload: string) => {
  shouts++;
  return `shout:${payload}`;
});

/** The payloads `ps_once` bodies ran on. */
let onceBodies: string[] = [];
registerStepFunction(
  'ps_once',
  Object.assign(
    async (payload: string) => {
      onceBodies.push(payload);
      return `once:${payload}`;
    },
    { maxRetries: 0 }
  )
);

/** {@link sessionWorkflow} on `stepName`, for `count` payloads. */
const sessionWorkflowOf = (
  stepName: string,
  count: number
) => `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(stepName)});
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const replies = [];
    for await (const payload of hook) {
      replies.push(await step(payload));
      if (replies.length === ${count}) break;
    }
    return replies;
  }${registerWorkflow()}`;
const shoutingSessionWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_echo");
  const shout = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ps_shout");
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const replies = [];
    for await (const payload of hook) {
      replies.push(await (replies.length === 0 ? echo : shout)(payload));
      if (replies.length === 3) break;
    }
    return replies;
  }${registerWorkflow()}`;

/** Appends a payload for the session's hook, with no wake. */
async function land(world: AppendOnlyWorld, runId: string, payload: string) {
  world.appendOutOfBand({
    eventType: 'hook_received',
    runId,
    correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
    eventData: {
      token: TOKEN,
      payload: await dehydrateStepReturnValue(payload, runId, undefined),
    },
  } as unknown as Partial<Event>);
}

const wake = (world: AppendOnlyWorld, runId: string) =>
  world.deliver(world.enqueue(ORCHESTRATOR_QUEUE, { runId }));

/** In-band writes the World's fence refused. */
const fenceRefusals = (world: AppendOnlyWorld) => {
  const checkFence = vi.spyOn(
    world as unknown as { checkFence: (...args: unknown[]) => void },
    'checkFence'
  );
  return () =>
    checkFence.mock.results.filter((result) => result.type === 'throw').length;
};

describe("a stale parked VM and the other orchestrator's writes", () => {
  beforeEach(() => {
    shouts = 0;
    echoBodies = [];
    onceBodies = [];
  });

  // The fence keeps the log to one writer, but does not stop a body from
  // running twice: with run-ahead, a retriable step's body can start before
  // its start commits, so the racer the fence then refuses has run it too (see
  // "The in-band fence" in the README). A `maxRetries: 0` step never starts
  // ahead, and nor does any step with run-ahead off.
  it.each([
    ['a step that allows no retries', 'ps_once', undefined],
    ['a retriable step with run-ahead off', 'ps_echo', '0'],
  ])('lets one of it and the orchestrator still lingering past it write, and runs %s once', async (_label, stepName, runAheadDepth) => {
    if (runAheadDepth !== undefined) {
      vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', runAheadDepth);
    }
    // Holds each racer's first in-band `step_started` for the last payload
    // until the other one's arrives, so both reach the fence.
    let raceArmed = false;
    let racers = 0;
    let releaseRace!: () => void;
    const bothRacing = new Promise<void>((resolve) => {
      releaseRace = resolve;
    });
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflowOf(stepName, 3),
      [],
      {
        subscribe: true,
        async beforeCreate(data, params) {
          if (
            !raceArmed ||
            data.eventType !== 'step_started' ||
            (params as { inBand?: boolean } | undefined)?.inBand !== true
          ) {
            return;
          }
          if (++racers === 2) releaseRace();
          await Promise.race([
            bothRacing,
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
        },
      }
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    // This process's VM, parked after 'a'. Another process handles 'b' and
    // keeps lingering on the hook with its newer VM.
    const thisProcess = await getWorld();
    const stale = takeParkedSession(thisProcess, runId);
    expect(stale).toBeDefined();
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '10000');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS', '10000');
    await land(world, runId, 'b');
    const lingering = wake(world, runId);
    await vi.waitFor(
      () => expect(eventsOf(world, 'step_completed')).toHaveLength(2),
      { timeout: 5_000 }
    );
    expect(world.deliveries).toHaveLength(2);
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS', '0');
    parkSession(thisProcess, runId, stale!);
    const refusals = fenceRefusals(world);
    spanExporter.reset();

    // 'c' reaches both: the lingering orchestrator through its feed, and the
    // stale VM through its wake.
    raceArmed = true;
    await land(world, runId, 'c');
    await Promise.all([wake(world, runId), lingering]);
    await world.runUntilIdle();

    expect(racers).toBe(2);
    expect(refusals()).toBeGreaterThanOrEqual(1);
    expect(spanValues(READ)).toContain('crossed');
    const prefix = stepName === 'ps_once' ? 'once' : 'echo';
    expect(await runResult(world)).toEqual(
      ['a', 'b', 'c'].map((payload) => `${prefix}:${payload}`)
    );
    expect(stepName === 'ps_once' ? onceBodies : echoBodies).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(eventsOf(world, 'step_started')).toHaveLength(3);
  });

  it('does not let the stale VM replace the newer one when their deliveries finish out of order', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflowOf('ps_echo', 4),
      []
    );
    await world.deliver(start);
    const thisProcess = await getWorld();
    // The start's VM goes aside while another process handles 'a', so it is
    // stale when it comes back.
    const stale = takeParkedSession(thisProcess, runId);
    expect(stale).toBeDefined();
    await send(world, runId, 'a');
    takeParkedSession(thisProcess, runId);
    parkSession(thisProcess, runId, stale!);

    // The stale VM resumes over 'a' to handle 'b'. Its read after the turn
    // comes back late, after another delivery handled 'c' and parked.
    let holdRead = true;
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const list = thisProcess.events.list.bind(thisProcess.events);
    const reading = vi
      .spyOn(thisProcess.events, 'list')
      .mockImplementation(async (params) => {
        const page = await list(params);
        if (
          holdRead &&
          params.pagination?.cursor !== undefined &&
          eventsOf(world, 'step_completed').length === 2
        ) {
          holdRead = false;
          await readHeld;
        }
        return page;
      });
    await land(world, runId, 'b');
    const crossed = wake(world, runId);
    await vi.waitFor(() => expect(holdRead).toBe(false));
    await send(world, runId, 'c');
    const newer = takeParkedSession(thisProcess, runId);
    expect(newer).toBeDefined();
    parkSession(thisProcess, runId, newer!);
    spanExporter.reset();

    releaseRead();
    await crossed;
    reading.mockRestore();
    expect(spanValues(READ)).toEqual(['crossed']);
    expect(spanValues(SKIP_REASON)).toEqual(['newer_parked']);
    expect(takeParkedSession(thisProcess, runId)?.tailSlot).toBe(
      newer!.tailSlot
    );
    parkSession(thisProcess, runId, newer!);

    const replays = coldReplays.count;
    await send(world, runId, 'd');
    expect(await runResult(world)).toEqual([
      'echo:a',
      'echo:b',
      'echo:c',
      'echo:d',
    ]);
    expect(echoes).toBe(4);
    // 'd' resumed the newer VM.
    expect(coldReplays.count).toBe(replays);
  });

  it("replays from cold when another orchestrator's events make the parked VM diverge, without spending the divergence budget", async () => {
    // A divergence the delivery counted would fail the run on the spot.
    vi.stubEnv('WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES', '0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, runId, start } = await setupOrchestratorRun(
      sessionWorkflow,
      []
    );
    await world.deliver(start);
    await send(world, runId, 'a');
    const thisProcess = await getWorld();
    const stale = takeParkedSession(thisProcess, runId);
    expect(stale).toBeDefined();
    // A new deployment, elsewhere, handles 'b' with its new step.
    await workflowEntrypoint(shoutingSessionWorkflow)(
      new Request('https://example.test')
    );
    await send(world, runId, 'b');
    expect(shouts).toBe(1);
    takeParkedSession(thisProcess, runId);
    parkSession(thisProcess, runId, stale!);
    const replays = coldReplays.count;
    spanExporter.reset();

    await send(world, runId, 'c');
    const diverged = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('Parked VM diverged'));
    warn.mockRestore();

    expect(spanValues(READ)).toEqual(['crossed']);
    expect(spanValues(DIVERGED)).toEqual([true]);
    expect(diverged).toHaveLength(1);
    expect(diverged[0]).toMatch(/crossedWrites\W+true/);
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    // The one cold replay that replaced the VM, on the new deployment.
    expect(coldReplays.count).toBe(replays + 1);
    expect(await runResult(world)).toEqual(['echo:a', 'shout:b', 'shout:c']);
    expect(echoes).toBe(1);
    expect(shouts).toBe(2);
  });
});
