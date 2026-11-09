import { InBandSupersededError, RunExpiredError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
} from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { setAttributes } from '../../set-attributes.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  expectRefusalRedelivery,
  runResult,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { ReplayBudget } from '../replay-budget.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';

function transform(name: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(name)}, ${name}]]);`;
}

let currentEngine: 'node' | 'quickjs' = 'node';
let currentWorld: AppendOnlyWorld | undefined;

/** What the world looked like each time a step body started. */
interface BodyObservation {
  listCalls: number;
  eventTypes: string[];
}
let bodies: BodyObservation[] = [];
/** Run by a step body after it records what it saw, then cleared. */
let onBody: (() => void) | undefined;

registerStepFunction('turbo_add', async (a: number, b: number) => {
  bodies.push({
    listCalls: currentWorld?.listCalls.length ?? -1,
    eventTypes: currentWorld?.events.map((e) => e.eventType) ?? [],
  });
  const hook = onBody;
  onBody = undefined;
  hook?.();
  return a + b;
});

registerStepFunction('turbo_branch', async (n: number) => {
  bodies.push({
    listCalls: currentWorld?.listCalls.length ?? -1,
    eventTypes: currentWorld?.events.map((e) => e.eventType) ?? [],
  });
  const hook = onBody;
  onBody = undefined;
  hook?.();
  return n * 2;
});

/** `n` branches: the first inline slots run here, the rest in the background. */
const fanOut = `const branch = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_branch");
  async function workflow(n) {
    const out = await Promise.all(Array.from({ length: n }, (_, i) => branch(i)));
    return out.reduce((a, b) => a + b, 0);
  }${transform('workflow')}`;

const twoSteps = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_add");
  async function workflow(a, b) {
    const first = await add(a, b);
    return await add(first, 10);
  }${transform('workflow')}`;

registerStepFunction('turbo_attributes', async (n: number) => {
  await setAttributes({ phase: 'step-started' });
  await setAttributes({ phase: 'step-done' });
  return n * 4;
});

registerStepFunction(
  'turbo_once',
  Object.assign(
    async (n: number) => {
      bodies.push({
        listCalls: currentWorld?.listCalls.length ?? -1,
        eventTypes: currentWorld?.events.map((e) => e.eventType) ?? [],
      });
      const hook = onBody;
      onBody = undefined;
      hook?.();
      return n + 1;
    },
    // Allows no retries: not idempotent.
    { maxRetries: 0 }
  )
);

const onceStep = `const once = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_once");
  async function workflow(n) {
    return await once(n);
  }${transform('workflow')}`;

const attributesStep = `const attrs = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_attributes");
  async function workflow(n) {
    return await attrs(n);
  }${transform('workflow')}`;

const stepThenSleep = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_add");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(a, b) {
    const first = await add(a, b);
    await sleep(1);
    return await add(first, 10);
  }${transform('workflow')}`;

async function runInputFor(runId: string, args: unknown[]) {
  return {
    input: await dehydrateWorkflowArguments(args, runId, undefined, []),
    deploymentId: 'dpl_test',
    workflowName: 'workflow',
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    executionContext: { workflowVm: currentEngine },
  };
}

/**
 * A run as `start()` leaves it: `run_created` written (unless `seed` is
 * false, which is a resilient start whose `run_created` never landed) and
 * the first orchestrator message, carrying `runInput`, enqueued.
 */
async function setup(
  code: string,
  args: unknown[],
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = { fence: true },
  seed = true
) {
  // A ULID run id, as `start()` mints: replay's clock and correlation ids
  // derive from its timestamp, not from the run's (here synthesized)
  // `createdAt`.
  const runId = `wrun_${ulid()}`;
  const world = new AppendOnlyWorld(options);
  if (seed) {
    world.seedRun({
      runId,
      workflowName: 'workflow',
      deploymentId: 'dpl_test',
      status: 'pending',
      executionContext: { workflowVm: currentEngine },
      input: await dehydrateWorkflowArguments(args, runId, undefined, []),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as WorkflowRun);
  }
  currentWorld = world;
  setWorld(world.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(QUEUE, {
    runId,
    requestedAt: new Date(),
    runInput: await runInputFor(runId, args),
  });
  return { world, runId, start };
}

const types = (events: readonly Event[]) => events.map((e) => e.eventType);
const indexOf = (world: AppendOnlyWorld, type: string) =>
  world.events.findIndex((e) => e.eventType === type);

const ENV = ['WORKFLOW_TURBO', 'WORKFLOW_OPTIMISTIC_INLINE_START'] as const;
const savedEnv: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

beforeEach(() => {
  bodies = [];
  onBody = undefined;
  for (const key of ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  setWorld(undefined);
  for (const key of ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe.each([
  'node',
  'quickjs',
] as const)('turbo first delivery against an append-only World (%s engine)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  it('runs the first step body with no log load before it, ahead of run_started', async () => {
    // Hold `run_started` until the first body has run: the body can only
    // run first if nothing on the way to it waits for that write.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    onBody = () => release();
    const { world, start } = await setup(twoSteps, [1, 2], {
      fence: true,
      async beforeCreate(data) {
        if (data.eventType === 'run_started') await held;
      },
    });

    await world.deliver(start);
    await world.runUntilIdle();

    expect(types(world.events).filter((t) => t === 'run_completed')).toEqual([
      'run_completed',
    ]);
    // (a) The first body ran with no `events.list` before it, and before
    // anything but the run's creation was durable.
    expect(bodies[0]).toEqual({ listCalls: 0, eventTypes: ['run_created'] });
    // The whole run finished on its first delivery.
    expect(world.deliveries).toHaveLength(1);
    // (b) Every write still lands after run_started, in decision order.
    expect(types(world.events)).toEqual([
      'run_created',
      'run_started',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
    // Every write was in-band, and the fence count started from the run's
    // creation without a load snapshot.
    // A batch's events share one expected count: the positions before it.
    const expected = world.creates.map((c) => c.params?.expectedSeqInBand);
    const firstOfWrite = world.creates.map((c) =>
      world.creates.findIndex((d) => d.params === c.params)
    );
    expect(expected).toEqual(firstOfWrite.map((i) => i + 1));
    expect(world.creates[0]?.params).toMatchObject({
      inBand: true,
      skipPreload: true,
    });
  });

  it('loads the log on a coalesced re-run of the first delivery', async () => {
    // A queue that coalesced other messages into the first delivery runs its
    // handler again: the log holds that delivery's writes by then, so the
    // re-run is a redelivery, not a first delivery.
    const { world, start } = await setup(twoSteps, [1, 2]);

    await world.deliver({ ...start, coalescedRerun: 1 });
    await world.runUntilIdle();

    expect(types(world.events).filter((t) => t === 'run_completed')).toEqual([
      'run_completed',
    ]);
    expect(bodies[0]!.listCalls).toBeGreaterThan(0);
    expect(world.creates[0]?.params).not.toMatchObject({ skipPreload: true });
  });

  it('stops the delivery when the fence refuses the backgrounded run_started, and asks for a redelivery', async () => {
    let refuse = true;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    onBody = () => release();
    const { world, start } = await setup(twoSteps, [1, 2], {
      fence: true,
      async beforeCreate(data) {
        if (data.eventType === 'run_started' && refuse) {
          refuse = false;
          // Refused only after the optimistic body ran, the latest it can
          // arrive.
          await held;
          throw new InBandSupersededError('in-band-superseded', {
            seq: 1,
            seqInBand: 2,
          });
        }
      },
    });

    const first = await world.deliver(start);

    // (c) Superseded: a redelivery of the same message, and nothing sent in
    // its place. The body that started ahead of run_started ran, but nothing
    // it or the orchestrator would have written reached the World.
    expect(bodies).toHaveLength(1);
    expect(types(world.events)).toEqual(['run_created']);
    expect(world.creates).toEqual([]);
    expectRefusalRedelivery(world, first, start, 0);
    expect(world.held).toHaveLength(1);
    expect(world.queueCalls).toHaveLength(0);

    // The redelivery is not turbo: it loads the log first and completes.
    await world.runUntilIdle();
    expect(world.listCalls.length).toBeGreaterThan(0);
    expect(indexOf(world, 'run_completed')).toBeGreaterThan(0);
    expect(types(world.events).slice(0, 3)).toEqual([
      'run_created',
      'run_started',
      'step_started',
    ]);
  });

  it('acknowledges without writing when run_started finds the run already finished', async () => {
    const { world, start } = await setup(twoSteps, [1, 2], {
      fence: true,
      beforeCreate(data) {
        if (data.eventType === 'run_started') {
          throw new RunExpiredError('run was cancelled');
        }
      },
    });

    const result = await world.deliver(start);

    expect(result).toBeUndefined();
    expect(types(world.events)).toEqual(['run_created']);
    expect(world.held).toEqual([]);
  });

  it('completes a resilient start (run_created never landed) under turbo', async () => {
    const { world, start } = await setup(
      twoSteps,
      [1, 2],
      { fence: true },
      false
    );

    await world.deliver(start);
    await world.runUntilIdle();

    // (d) run_started created the run, and the run finished on the first
    // delivery.
    expect(world.deliveries).toHaveLength(1);
    expect(types(world.events)).toEqual([
      'run_created',
      'run_started',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
    expect(bodies[0]?.listCalls).toBe(0);
  });

  it('completes a resilient start whose run_started the World recorded as the creation, under turbo', async () => {
    // The World writes the creating `run_started` at the first slot, where
    // turbo holds a `run_created` it built without loading the log: the two
    // replay alike, and the write's `allocated` keeps the fence count right.
    const { world, start } = await setup(
      twoSteps,
      [1, 2],
      { creationOnStart: true },
      false
    );

    await world.deliver(start);
    await world.runUntilIdle();

    expect(world.deliveries).toHaveLength(1);
    expect(types(world.events)).toEqual([
      'run_started',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
    expect(bodies[0]?.listCalls).toBe(0);
  });

  it('starts bodies only after their start commits once the run has a wait', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    onBody = () => release();
    const { world, start } = await setup(stepThenSleep, [1, 2], {
      fence: true,
      async beforeCreate(data) {
        if (data.eventType === 'run_started') await held;
      },
    });

    await world.deliver(start);
    await world.runUntilIdle();

    expect(indexOf(world, 'run_completed')).toBeGreaterThan(0);
    expect(bodies).toHaveLength(2);
    // The first step was optimistic: nothing but the creation was durable.
    expect(bodies[0]?.eventTypes).toEqual(['run_created']);
    // The second came after the sleep: its own start had committed first.
    const second = bodies[1]?.eventTypes ?? [];
    expect(second.at(-1)).toBe('step_started');
  });

  it('awaits each start under WORKFLOW_OPTIMISTIC_INLINE_START=0, and still skips the load', async () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '0';
    const { world, start } = await setup(twoSteps, [1, 2]);

    await world.deliver(start);
    await world.runUntilIdle();

    expect(indexOf(world, 'run_completed')).toBeGreaterThan(0);
    expect(world.deliveries).toHaveLength(1);
    expect(bodies[0]).toEqual({
      listCalls: 0,
      eventTypes: ['run_created', 'run_started', 'step_started'],
    });
  });

  it('loads the log and awaits run_started first with WORKFLOW_TURBO=0', async () => {
    process.env.WORKFLOW_TURBO = '0';
    const { world, start } = await setup(twoSteps, [1, 2]);

    await world.deliver(start);
    await world.runUntilIdle();

    expect(indexOf(world, 'run_completed')).toBeGreaterThan(0);
    expect(bodies[0]?.listCalls).toBeGreaterThan(0);
    expect(bodies[0]?.eventTypes).toEqual([
      'run_created',
      'run_started',
      'step_started',
    ]);
  });

  // A World refuses every event but the run's lifecycle until `run_started`
  // commits, and turbo writes it in the background while the first body
  // runs. The body's own World writes wait for it, whichever way its start
  // was claimed: the creation batch can pre-claim it while `run_started` is
  // still in flight.
  it("holds a step body's out-of-band writes until the backgrounded run_started commits", async () => {
    const { world, start } = await setup(attributesStep, [9], {
      async beforeCreate(data: { eventType: string }) {
        if (data.eventType === 'run_started') {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
    });
    await world.deliver(start);
    await world.runUntilIdle();

    expect(world.events.filter((e) => e.eventType === 'attr_set')).toHaveLength(
      2
    );
    expect(world.events.at(-1)?.eventType).toBe('run_completed');
  });

  it("continues on a World's rotated start message without running a completed step's body again", async () => {
    // The start message hands off right after the first step completes: past
    // the function's deadline (node), or out of replay budget (QuickJS). Its
    // message is old, so the World continues the run on a new message (a
    // first delivery) instead of handing it off.
    const MESSAGE_AGE_MS = 23 * 60 * 60_000;
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    // A `run_started` a delivery of the new message writes is held until a
    // body runs (or for a second): a fresh-start path over this log would
    // run the first step's body again while that write is in flight, before
    // the fence refuses it.
    let release: () => void = () => {};
    const bodyRan = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 1000);
    });
    try {
      if (engine === 'node') {
        onBody = () => {
          offsetMs += 30 * 60_000;
        };
      }
      const { world, start } = await setup(twoSteps, [1, 2], {
        rotateHandoff: (held) => realNow() - +held.createdAt >= MESSAGE_AGE_MS,
        async beforeCreate(data) {
          if (data.eventType === 'run_started' && world.rotations > 0) {
            onBody = () => release();
            await bodyRan;
          }
        },
      });
      start.createdAt = new Date(realNow() - MESSAGE_AGE_MS);
      if (engine === 'quickjs') {
        vi.spyOn(ReplayBudget.prototype, 'isExhausted').mockImplementation(
          () =>
            world.rotations === 0 &&
            world.events.some((e) => e.eventType === 'step_completed')
        );
      }

      expect(await world.deliver(start)).toEqual({ timeoutSeconds: 0 });
      expect(world.rotations).toBe(1);
      expect(bodies).toHaveLength(1);
      const [rotated] = world.held;
      expect(rotated).toMatchObject({ deliveryCount: 1 });

      await world.runUntilIdle();
      expect(world.events.at(-1)?.eventType).toBe('run_completed');
      // One body per step: the rotated message loaded the log.
      expect(bodies).toHaveLength(2);
      expect(types(world.events).filter((t) => t === 'step_started')).toEqual([
        'step_started',
        'step_started',
      ]);
      expect(await runResult(world)).toBe(13);
      expect(rotated!.message).not.toHaveProperty('runInput');
    } finally {
      clock.mockRestore();
      vi.restoreAllMocks();
    }
  });

  // Turbo runs a first step's body before its start commits, unless the
  // step allows no retries: then the body waits for a durable step_started.
  it.each([
    { name: 'with batch writes', noBatch: false },
    { name: 'on a World without createBatch', noBatch: true },
  ])('starts a step that allows no retries only after its step_started commits ($name)', async ({
    noBatch,
  }) => {
    // Hold `run_started` until a body runs, or for a second (longer than the
    // first compile of the workflow): a body that may run ahead of its start
    // runs while it is held, and this one may not.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 1000);
    });
    onBody = () => release();
    const { world, start } = await setup(onceStep, [1], {
      fence: true,
      noBatch,
      async beforeCreate(data: { eventType: string }) {
        if (data.eventType === 'run_started') await held;
      },
    });
    await world.deliver(start);
    await world.runUntilIdle();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.eventTypes).toContain('step_started');
    expect(world.events.at(-1)?.eventType).toBe('run_completed');
  });
});

// The node engine only: QuickJS writes a suspension's creations through its
// own path (`spec9/quickjs-entrypoint.ts`), which commits them first.
describe('turbo fan-out on the node engine', () => {
  beforeEach(() => {
    currentEngine = 'node';
  });

  const BRANCHES = 8;
  const SUM = BRANCHES * (BRANCHES - 1);

  it("starts a fan-out's inline bodies before its creations commit, and its background steps only after", async () => {
    // Hold the creation batch until an inline body has run: the body can
    // only run first if it does not wait for its creation to commit.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
      // Without the early start the batch would wait for a body that
      // waits for it: let it go, so that fails the assertions below.
      setTimeout(resolve, 2_000).unref?.();
    });
    let stepMessagesAtFirstBody = -1;
    const { world, start } = await setup(fanOut, [BRANCHES], {
      fence: true,
      async beforeCreate(data, _params, source) {
        if (source?.batch && data.eventType === 'step_created') await held;
      },
    });
    onBody = () => {
      stepMessagesAtFirstBody = stepMessagesOf(world).length;
      release();
    };

    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(SUM);
    // The first body ran before any step's creation was durable, and before
    // any background step's message went out.
    expect(
      bodies[0]?.eventTypes.filter((type) => type.startsWith('step_'))
    ).toEqual([]);
    expect(bodies[0]?.listCalls).toBe(0);
    expect(stepMessagesAtFirstBody).toBe(0);
    // Every branch ran once: 3 inline, the rest from their messages.
    expect(bodies).toHaveLength(BRANCHES);
    expect(stepMessagesOf(world)).toHaveLength(BRANCHES - 3);
    // Every write still lands after run_started, in decision order.
    const order = types(world.events);
    expect(order.indexOf('run_started')).toBe(1);
    expect(order.filter((t) => t === 'step_completed')).toHaveLength(BRANCHES);
  });

  it('commits a fan-out first when one of its inline steps allows no retries', async () => {
    // The first branch takes an inline slot and must not run before its
    // start is durable.
    const mixed = `const once = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_once");
      const branch = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("turbo_branch");
      async function workflow(n) {
        const out = await Promise.all([
          once(0),
          ...Array.from({ length: n }, (_, i) => branch(i)),
        ]);
        return out.reduce((a, b) => a + b, 0);
      }${transform('workflow')}`;
    // Hold the creation batch a while: an inline body that started ahead
    // of it would run in the meantime.
    let bodiesWhileHeld: number | undefined;
    const { world, start } = await setup(mixed, [BRANCHES], {
      fence: true,
      async beforeCreate(data, _params, source) {
        if (!source?.batch || data.eventType !== 'step_created') return;
        if (bodiesWhileHeld !== undefined) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
        bodiesWhileHeld = bodies.length;
      },
    });

    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(1 + SUM);
    expect(bodies).toHaveLength(BRANCHES + 1);
    // No body ran before the boundary's creations were durable.
    expect(bodiesWhileHeld).toBe(0);
  });

  it('commits a fan-out first under WORKFLOW_OPTIMISTIC_INLINE_START=0', async () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '0';
    const { world, start } = await setup(fanOut, [BRANCHES]);

    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(SUM);
    expect(bodies[0]?.eventTypes).toContain('step_started');
    expect(bodies[0]?.eventTypes).toContain('step_created');
  });

  it('redelivers and completes when the creation batch an inline body started ahead of fails', async () => {
    let refused = false;
    const { world, start } = await setup(fanOut, [BRANCHES], {
      fence: true,
      beforeCreate(data, _params, source) {
        if (source?.batch && data.eventType === 'step_created' && !refused) {
          refused = true;
          throw Object.assign(new Error('unavailable'), { status: 503 });
        }
      },
    });

    // The failed batch fails the delivery once its bodies settled; the
    // queue redelivers it, and the redelivery decides from the log.
    await expect(world.deliver(start)).rejects.toThrow('unavailable');
    await world.runUntilIdle();

    expect(refused).toBe(true);
    expect(world.deliveries[1]?.deliveryCount).toBe(2);
    expect(await runResult(world)).toBe(SUM);
    // Each branch completed exactly once in the log, whatever ran twice.
    const completed = world.events.filter(
      (e) => e.eventType === 'step_completed'
    );
    expect(new Set(completed.map((e) => e.correlationId)).size).toBe(BRANCHES);
    expect(completed).toHaveLength(BRANCHES);
  });
});
