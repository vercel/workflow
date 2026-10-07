import { InBandSupersededError, RunExpiredError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { setAttributes } from '../../set-attributes.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { setWorld } from '../world.js';
import { FENCE_REDELIVERY_DELAY_SECONDS } from './in-band-writer.js';

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
    specVersion: SPEC_VERSION_CURRENT,
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
      'step_created',
      'step_started',
      'step_completed',
      'step_created',
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

  it('stops the delivery when the fence refuses the backgrounded run_started, and redelivers', async () => {
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

    // (c) Superseded: not acknowledged, redelivered after the fence delay.
    expect(first).toEqual({ timeoutSeconds: FENCE_REDELIVERY_DELAY_SECONDS });
    // The body that started ahead of run_started ran, but nothing it or the
    // orchestrator would have written reached the World.
    expect(bodies).toHaveLength(1);
    expect(types(world.events)).toEqual(['run_created']);
    expect(world.creates).toEqual([]);
    expect(world.held).toHaveLength(1);
    expect(world.held[0]?.deliveryCount).toBe(2);

    // The redelivery is not turbo: it loads the log first and completes.
    await world.runUntilIdle();
    expect(world.listCalls.length).toBeGreaterThan(0);
    expect(indexOf(world, 'run_completed')).toBeGreaterThan(0);
    expect(types(world.events).slice(0, 3)).toEqual([
      'run_created',
      'run_started',
      'step_created',
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
      'step_created',
      'step_started',
      'step_completed',
      'step_created',
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
      eventTypes: [
        'run_created',
        'run_started',
        'step_created',
        'step_started',
      ],
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
      'step_created',
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
});
