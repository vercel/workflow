import { InBandSupersededError } from '@workflow/errors';
import { type Event, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { RUN_AHEAD_DEPTH } from '../constants.js';
import {
  SLOT_GAP_RECHECK_ATTEMPTS,
  SLOT_GAP_RECHECK_BASE_DELAY_MS,
} from '../helpers.js';
import { wakeUpRun } from '../runs.js';
import { setWorld } from '../world.js';
import { FENCE_REDELIVERY_DELAY_SECONDS } from './in-band-writer.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// Run-ahead (runtime/out-of-band-observation.ts): at an inert boundary an
// inline step's outcome reaches the workflow before its write commits, so
// the next step's body can start while the previous step_completed is still
// in flight.

let currentWorld: AppendOnlyWorld | undefined;
/** Per body start: how many earlier steps' outcomes had not committed yet. */
let unconfirmedAtStart: number[] = [];
let bodiesStarted = 0;

registerStepFunction('ra_inc', async (n: number) => {
  bodiesStarted++;
  const world = currentWorld;
  if (world) {
    const outcomes = eventsOf(world, 'step_completed').length;
    // Every step before this one is `bodiesStarted - 1`.
    unconfirmedAtStart.push(bodiesStarted - 1 - outcomes);
  }
  return n + 1;
});

const step = `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ra_inc")`;

const sequential = `const inc = ${step};
  async function workflow(steps) {
    let n = 0;
    for (let i = 0; i < steps; i++) n = await inc(n);
    return n;
  }${registerWorkflow()}`;

// An open hook nobody awaits until the loop is done.
const unobservedHook = `const inc = ${step};
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow(steps) {
    const hook = createHook({ token: "ra-unobserved" });
    let n = 0;
    for (let i = 0; i < steps; i++) n = await inc(n);
    return n;
  }${registerWorkflow()}`;

// A hook the workflow waits on while it runs steps, then a second loop
// after the hook resolved.
const observedHook = `const inc = ${step};
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow(steps) {
    const hook = createHook({ token: "ra-observed" });
    let resolved = false;
    hook.then(() => { resolved = true; });
    let n = 0;
    while (!resolved && n < 50) n = await inc(n);
    for (let i = 0; i < steps; i++) n = await inc(n);
    return n;
  }${registerWorkflow()}`;

const withAbortSignal = `const inc = ${step};
  async function workflow(steps) {
    const controller = new AbortController();
    let n = 0;
    for (let i = 0; i < steps; i++) n = await inc(n);
    return controller.signal.aborted ? -1 : n;
  }${registerWorkflow()}`;

const withSleep = (duration: string) => `const inc = ${step};
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(steps) {
    const timer = sleep(${JSON.stringify(duration)});
    let n = 0;
    for (let i = 0; i < steps; i++) n = await inc(n);
    return n;
  }${registerWorkflow()}`;

const sleepThenStep = `const inc = ${step};
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    await sleep("1h");
    return await inc(41);
  }${registerWorkflow()}`;

// Two inline steps at once: one's outcome can run ahead while the other's
// start is still queued in the writer.
const parallelPair = `const inc = ${step};
  async function workflow() {
    const [a, b] = await Promise.all([inc(1), inc(10)]);
    return a + b;
  }${registerWorkflow()}`;

const STEPS = 6;

/**
 * Holds every step_completed write back before it commits, as a remote
 * World's round trip does, so a body that starts ahead of the previous
 * outcome sees it uncommitted.
 */
const slowOutcomes = {
  async beforeCreate(data: { eventType: string }) {
    if (data.eventType === 'step_completed') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  },
};

async function run(
  code: string,
  args: unknown[],
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = slowOutcomes
) {
  const setup = await setupOrchestratorRun(code, args, options, 'node');
  currentWorld = setup.world;
  return setup;
}

/** The log as event types and step names, comparable across runs. */
function shape(events: readonly Event[]): string[] {
  return events.map((event) => {
    const name = dataOf(event)?.stepName;
    return name ? `${event.eventType}:${String(name)}` : event.eventType;
  });
}

/** Replays `world`'s committed log, up to its terminal event, in a fresh World. */
async function coldReplay(world: AppendOnlyWorld, code: string) {
  const cold = new AppendOnlyWorld();
  const run = await world.asWorld().runs.get(world.events[0]!.runId);
  const terminal = world.events.findIndex(
    (event) => event.eventType === 'run_completed'
  );
  cold.seedLog({ ...run, status: 'running' }, world.events.slice(0, terminal));
  setWorld(cold.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  await cold.deliver(cold.enqueue(ORCHESTRATOR_QUEUE, { runId: run.runId }));
  return { result: await runResult(cold), world: cold };
}

beforeEach(() => {
  unconfirmedAtStart = [];
  bodiesStarted = 0;
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // A step body's base URL comes from here instead of probing the local
  // port, which takes long enough to hide what these tests time.
  vi.stubEnv('VERCEL_URL', 'run-ahead.example.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
  currentWorld = undefined;
});

describe('run-ahead against an append-only World (node engine)', () => {
  it('starts the next inline step before the previous step_completed commits, and leaves the same log', async () => {
    const { world } = await run(sequential, [STEPS]);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(STEPS);
    expect(world.deliveries).toHaveLength(1);
    // Some body started with an earlier outcome still in flight.
    expect(Math.max(...unconfirmedAtStart)).toBeGreaterThan(0);

    // The same workflow with run-ahead off leaves the same log.
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
    unconfirmedAtStart = [];
    bodiesStarted = 0;
    const off = await run(sequential, [STEPS]);
    await off.world.runUntilIdle();
    expect(await runResult(off.world)).toBe(STEPS);
    expect(unconfirmedAtStart.every((n) => n === 0)).toBe(true);
    expect(shape(world.events)).toEqual(shape(off.world.events));
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', String(RUN_AHEAD_DEPTH));

    // A cold replay of the run-ahead log decides the same way.
    const cold = await coldReplay(world, sequential);
    expect(cold.result).toBe(STEPS);
    // It runs no step again: every outcome is in the log.
    expect(eventsOf(cold.world, 'step_started')).toHaveLength(STEPS);
  });

  it('does not read a queued sibling start below a speculative outcome as a hole in the log', async () => {
    // The second step's start commits late, later than the slot-gap check's
    // re-reads could wait for it, so the first step's outcome is placed above
    // a position the writer has yet to fill. Separate start writes (no batch)
    // put the two starts behind the two creations, as on world-local.
    const reReadWindowMs = Array.from(
      { length: SLOT_GAP_RECHECK_ATTEMPTS },
      (_, attempt) => SLOT_GAP_RECHECK_BASE_DELAY_MS * 2 ** attempt
    ).reduce((sum, ms) => sum + ms, 0);
    let starts = 0;
    const { world } = await run(parallelPair, [], {
      noBatch: true,
      async beforeCreate(data: { eventType: string }) {
        if (data.eventType === 'step_started' && ++starts === 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 2 * reReadWindowMs)
          );
        }
      },
    });
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(13);
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'step_started')).toHaveLength(2);
  });

  it('keeps at most WORKFLOW_RUN_AHEAD_DEPTH steps unconfirmed', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '1');
    const one = await run(sequential, [STEPS]);
    await one.world.runUntilIdle();
    expect(await runResult(one.world)).toBe(STEPS);
    expect(Math.max(...unconfirmedAtStart)).toBe(1);

    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', String(RUN_AHEAD_DEPTH));
    unconfirmedAtStart = [];
    bodiesStarted = 0;
    const two = await run(sequential, [STEPS]);
    await two.world.runUntilIdle();
    expect(Math.max(...unconfirmedAtStart)).toBeLessThanOrEqual(
      RUN_AHEAD_DEPTH
    );
  });

  it('runs ahead with an open hook nobody waits on', async () => {
    const { world } = await run(unobservedHook, [STEPS]);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(STEPS);
    expect(Math.max(...unconfirmedAtStart)).toBeGreaterThan(0);
  });

  it('drains while the workflow waits on a hook, and runs ahead again once it resolved', async () => {
    const { world, runId } = await run(observedHook, [STEPS], {
      async beforeCreate(data) {
        await slowOutcomes.beforeCreate(data);
        // The hook's payload lands once the third step has completed.
        if (
          data.eventType === 'step_completed' &&
          eventsOf(world, 'step_completed').length === 2 &&
          eventsOf(world, 'hook_received').length === 0
        ) {
          const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
          world.appendOutOfBand({
            eventType: 'hook_received',
            runId,
            correlationId: hookId,
            eventData: {
              token: 'ra-observed',
              payload: await dehydrateStepReturnValue(
                { ok: true },
                runId,
                undefined
              ),
            },
          } as unknown as Partial<Event>);
        }
      },
    });
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    const hookAt = world.events.findIndex(
      (e) => e.eventType === 'hook_received'
    );
    const before = eventsOf(world, 'step_completed').filter(
      (e) => world.events.indexOf(e) < hookAt
    ).length;
    // While the hook was awaited, no body started ahead of an outcome.
    expect(unconfirmedAtStart.slice(0, before).every((n) => n === 0)).toBe(
      true
    );
    // After it resolved, the loop ran ahead again.
    expect(Math.max(...unconfirmedAtStart.slice(before))).toBeGreaterThan(0);
  });

  it('drains with an AbortController open', async () => {
    const { world } = await run(withAbortSignal, [STEPS]);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(STEPS);
    expect(unconfirmedAtStart.every((n) => n === 0)).toBe(true);
  });

  it('drains beside a step another invocation runs', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    const fanOut = `const inc = ${step};
      async function workflow() {
        const [a, b] = await Promise.all([inc(1), inc(2)]);
        let n = a + b;
        for (let i = 0; i < 3; i++) n = await inc(n);
        return n;
      }${registerWorkflow()}`;
    const { world } = await run(fanOut, []);
    // The background step's message goes out, but this test does not run
    // it until the orchestrator has suspended on it.
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(8);
    // The inline step that ran beside the background one did not run ahead.
    expect(unconfirmedAtStart[0]).toBe(0);
  });

  it('drains with a wait due within the invocation, and runs ahead with a far-future one', async () => {
    const due = await run(withSleep('1s'), [STEPS]);
    await due.world.deliver(due.start);
    expect(unconfirmedAtStart.every((n) => n === 0)).toBe(true);

    unconfirmedAtStart = [];
    bodiesStarted = 0;
    const far = await run(withSleep('30d'), [STEPS]);
    await far.world.deliver(far.start);
    expect(eventsOf(far.world, 'step_completed')).toHaveLength(STEPS);
    expect(Math.max(...unconfirmedAtStart)).toBeGreaterThan(0);
  });

  it('stops with no orphan writes when the fence refuses a speculative write, and the redelivery completes', async () => {
    let refused = false;
    const { world, start } = await run(sequential, [STEPS], {
      async beforeCreate(data, params) {
        await slowOutcomes.beforeCreate(data);
        if (
          !refused &&
          data.eventType === 'step_completed' &&
          eventsOf(world, 'step_completed').length === 2
        ) {
          refused = true;
          throw new InBandSupersededError('in-band-superseded', {
            seq: world.seq,
            seqInBand: (params?.expectedSeqInBand ?? 0) + 1,
          });
        }
      },
    });

    const first = await world.deliver(start);
    expect(first).toEqual({ timeoutSeconds: FENCE_REDELIVERY_DELAY_SECONDS });
    // Nothing after the refused outcome reached the World: the log ends with
    // the refused step's start.
    expect(eventsOf(world, 'step_completed')).toHaveLength(2);
    expect(world.events.at(-1)?.eventType).toBe('step_started');

    await world.runUntilIdle();
    expect(await runResult(world)).toBe(STEPS);
    expect(eventsOf(world, 'step_completed')).toHaveLength(STEPS);
  });
});

describe.each([
  'node',
  'quickjs',
] as const)('run.wakeUp() on a single-orchestrator run (%s engine)', (engine) => {
  it('enqueues a wake instead of writing, and the orchestrator completes the wait in-band', async () => {
    const { world, runId } = await setupOrchestratorRun(
      sleepThenStep,
      [],
      {},
      engine
    );
    currentWorld = world;
    await world.deliver(world.held[0]!);
    expect(eventsOf(world, 'wait_created')).toHaveLength(1);
    const wait = eventsOf(world, 'wait_created')[0]!;
    // Drop the hour-long timer: only the wake-up may complete the wait.
    world.held.splice(0);
    const writesBefore = world.creates.length;

    const result = await wakeUpRun(world.asWorld(), runId);

    expect(result).toEqual({ stoppedCount: 1 });
    expect(world.creates.length).toBe(writesBefore);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    const wake = world.held.at(-1)?.message as {
      completeWaits?: string[];
    };
    expect(wake.completeWaits).toEqual([wait.correlationId]);

    await world.runUntilIdle();
    expect(await runResult(world)).toBe(42);
    const completed = world.creates.find(
      (c) => c.event.eventType === 'wait_completed'
    );
    expect(completed?.params?.inBand).toBe(true);
    expect(completed?.event.correlationId).toBe(wait.correlationId);
    expect(dataOf(completed?.event)?.resumeAt).toEqual(dataOf(wait)?.resumeAt);
    expect(completed?.event.specVersion).toBe(SPEC_VERSION_CURRENT);
  });
});
