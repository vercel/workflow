import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  orchestratorMessagesOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('rv_s1', async () => 10);
registerStepFunction('rv_s2', async () => 20);
const seenStates: unknown[] = [];
registerStepFunction(
  'rv_append',
  async (state: { items: number[] }, i: number) => {
    seenStates.push(structuredClone(state));
    return state.items.length * 10 + i;
  }
);

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;
const SLEEP = `globalThis[Symbol.for("WORKFLOW_SLEEP")]`;
const CREATE_HOOK = `globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]`;

const twoStepWorkflow = `const s1 = ${step('rv_s1')}; const s2 = ${step('rv_s2')};
  async function workflow() { return (await s1()) + (await s2()); }${registerWorkflow()}`;

// A sleep loses a race to an inline step, and a second step follows.
const openWaitRaceWorkflow = `const sleep = ${SLEEP};
  const s1 = ${step('rv_s1')}; const s2 = ${step('rv_s2')};
  async function workflow() {
    const a = await Promise.race([sleep("1h").then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }${registerWorkflow()}`;

// A long sleep created alongside s1 and awaited after it.
const sleepAfterStepWorkflow = `const sleep = ${SLEEP};
  const s1 = ${step('rv_s1')};
  async function workflow() {
    const nap = sleep("1h");
    const a = await s1();
    await nap;
    return a + 7;
  }${registerWorkflow()}`;

// The common polling shape: the sleep is created only after the step.
const stepThenSleepWorkflow = `const sleep = ${SLEEP};
  const s1 = ${step('rv_s1')};
  async function workflow() {
    const a = await s1();
    await sleep("5s");
    return a + 7;
  }${registerWorkflow()}`;

const TAKEN_TOKEN = 'rv-taken-token';

// A `hook.getConflict()` awaiter on a free token, then a step.
const getConflictCleanWorkflow = `const s1 = ${step('rv_s1')};
  const createHook = ${CREATE_HOOK};
  async function workflow() {
    const hook = createHook({ token: "rv-free-token" });
    const conflict = await hook.getConflict();
    const a = await s1();
    return conflict === null ? a : -1;
  }${registerWorkflow()}`;

// The same awaiter against a token another run holds.
const getConflictTakenWorkflow = `const s1 = ${step('rv_s1')};
  const createHook = ${CREATE_HOOK};
  async function workflow() {
    const hook = createHook({ token: "${TAKEN_TOKEN}" });
    let observed;
    try {
      observed = (await hook.getConflict()) === null ? "clean" : "conflict";
    } catch {
      observed = "conflict";
    }
    const a = await s1();
    return observed + ":" + a;
  }${registerWorkflow()}`;

// A plain payload await against a taken token: the conflict rejects it.
const awaitTakenWorkflow = `const s1 = ${step('rv_s1')};
  const createHook = ${CREATE_HOOK};
  async function workflow() {
    const hook = createHook({ token: "${TAKEN_TOKEN}" });
    let observed;
    try {
      await hook;
      observed = "payload";
    } catch {
      observed = "rejected";
    }
    const a = await s1();
    return observed + ":" + a;
  }${registerWorkflow()}`;

// Each step's input is state rebuilt from earlier step results.
const growingStateWorkflow = `const append = ${step('rv_append')};
  async function workflow() {
    let state = { items: [] };
    for (let i = 0; i < 3; i++) {
      const next = await append(state, i);
      state = { items: [...state.items, next] };
    }
    return state.items;
  }${registerWorkflow()}`;

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('retained orchestrator across its own writes (%s engine)', (engine) => {
  const setup = (
    code: string,
    options?: Parameters<typeof setupOrchestratorRun>[2]
  ) => setupOrchestratorRun(code, [], options ?? {}, engine);

  it('a sleep that lost a race costs no events.list per step boundary', async () => {
    const { world, start } = await setup(openWaitRaceWorkflow);
    await world.deliver(start);
    expect(await runResult(world)).toBe(30);
    // The whole run in one delivery.
    expect(world.deliveries).toHaveLength(1);
    if (engine === 'node') {
      // Exactly the reads of the same two steps with no sleep in the
      // picture: each inline outcome came back with its skipped-slot report.
      const baseline = await setup(twoStepWorkflow);
      await baseline.world.deliver(baseline.start);
      expect(await runResult(baseline.world)).toBe(30);
      expect(world.listCalls).toHaveLength(baseline.world.listCalls.length);
    }
  });

  it('sees a wait completion that lands right after a step outcome, and finishes the run', async () => {
    const { world, runId, start } = await setup(sleepAfterStepWorkflow);
    // `run.wakeUp()`'s shape: the completion lands right after the inline
    // step's terminal write, above its skipped-slot report, and wakes the
    // run without a key.
    const asWorld = world.asWorld();
    const create = asWorld.events.create.bind(asWorld.events);
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      if (args[1].eventType === 'step_completed') {
        const waitCreated = eventsOf(world, 'wait_created')[0]!;
        world.appendOutOfBand({
          eventType: 'wait_completed',
          correlationId: waitCreated.correlationId,
          eventData: { resumeAt: dataOf(waitCreated)?.resumeAt },
        } as Partial<Event>);
        world.enqueue(ORCHESTRATOR_QUEUE, { runId });
      }
      return result;
    }) as typeof create;
    setWorld(asWorld);

    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(17);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
  });

  it('parks on a sleep created after the step, with one read before parking, arming its timer once', async () => {
    const { world, start } = await setup(stepThenSleepWorkflow);
    await world.deliver(start);

    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    if (engine === 'node') {
      // The read before parking is incremental (from the loaded cursor): it
      // catches an event that landed after the VM decided, whose own wake
      // would otherwise find this position recorded as consumed.
      const cursorReads = world.listCalls.filter(
        (p) =>
          (p.pagination as { cursor?: string } | undefined)?.cursor !==
          undefined
      );
      expect(cursorReads).toHaveLength(1);
    }
    const timers = orchestratorMessagesOf(world);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.opts?.delaySeconds).toBeGreaterThan(0);
  });

  it('parks on an open sleep created beside the step, arming its timer once', async () => {
    const { world, start } = await setup(sleepAfterStepWorkflow);
    await world.deliver(start);

    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);
    expect(orchestratorMessagesOf(world)).toHaveLength(1);
  });

  describe('hook write continuation', () => {
    it('settles a getConflict() awaiter in the delivery that wrote the hook', async () => {
      const { world, start } = await setup(getConflictCleanWorkflow);
      await world.deliver(start);

      expect(await runResult(world)).toBe(10);
      expect(world.deliveries).toHaveLength(1);
      expect(world.queueCalls).toEqual([]);
    });

    it('settles a getConflict() awaiter on a taken token in the same delivery', async () => {
      const { world, start } = await setup(getConflictTakenWorkflow, {
        takenHookTokens: [TAKEN_TOKEN],
      });
      await world.deliver(start);

      expect(eventsOf(world, 'hook_conflict')).toHaveLength(1);
      expect(eventsOf(world, 'hook_created')).toHaveLength(0);
      expect(await runResult(world)).toBe('conflict:10');
      expect(world.deliveries).toHaveLength(1);
      // The delivery consumed its own hook_conflict: no wake for it.
      expect(world.queueCalls).toEqual([]);
    });

    it('rejects a payload await on a taken token and continues in the same delivery', async () => {
      const { world, start } = await setup(awaitTakenWorkflow, {
        takenHookTokens: [TAKEN_TOKEN],
      });
      await world.deliver(start);

      expect(await runResult(world)).toBe('rejected:10');
      expect(world.deliveries).toHaveLength(1);
      expect(world.queueCalls).toEqual([]);
    });

    it('still continues when the write response carries an incomplete report', async () => {
      const { world, start } = await setup(awaitTakenWorkflow, {
        takenHookTokens: [TAKEN_TOKEN],
        reportIncomplete: true,
      });
      await world.deliver(start);

      expect(await runResult(world)).toBe('rejected:10');
      expect(world.deliveries).toHaveLength(1);
      // The incomplete report was made up for by a read.
      expect(world.listCalls.length).toBeGreaterThan(1);
    });

    it.each([
      ['getConflict() on a free token', getConflictCleanWorkflow, [], 10],
      [
        'getConflict() on a taken token',
        getConflictTakenWorkflow,
        [TAKEN_TOKEN],
        'conflict:10',
      ],
      [
        'a payload await on a taken token',
        awaitTakenWorkflow,
        [TAKEN_TOKEN],
        'rejected:10',
      ],
    ] as const)('finishes %s with VM retention off', async (_label, code, taken, expected) => {
      vi.stubEnv('WORKFLOW_RETAINED_VM', '0');
      const { world } = await setup(code, {
        takenHookTokens: taken,
      });
      await world.runUntilIdle();
      expect(await runResult(world)).toBe(expected);
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    });
  });

  describe('replay without recorded step inputs', () => {
    beforeEach(() => {
      seenStates.length = 0;
    });

    it.each([
      ['skipped-slot reports', {}],
      ['reads after an incomplete report', { reportIncomplete: true }],
    ] as const)('hands every step the state rebuilt by replay (%s)', async (_label, options) => {
      const { world } = await setup(growingStateWorkflow, {
        ...options,
        skipStepInputs: true,
      });
      await world.runUntilIdle();

      expect(await runResult(world)).toEqual([0, 11, 22]);
      expect(seenStates).toEqual([
        { items: [] },
        { items: [0] },
        { items: [0, 11] },
      ]);
      // Every replay read asked for step inputs to be left out.
      expect(world.listCalls.length).toBeGreaterThan(0);
      expect(
        world.listCalls.every((p) => p.resolveData === 'skip-step-inputs')
      ).toBe(true);
      expect(eventsOf(world, 'step_completed')).toHaveLength(3);
    });

    it('replays a cold delivery over a log served without step inputs', async () => {
      // Force a fresh replay per step: each inline step runs in its own
      // delivery, so every later step is reached by replaying the earlier
      // ones from a list page with their inputs stripped.
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      const { world } = await setup(growingStateWorkflow, {
        skipStepInputs: true,
      });
      await world.runUntilIdle();

      expect(await runResult(world)).toEqual([0, 11, 22]);
      expect(seenStates).toEqual([
        { items: [] },
        { items: [0] },
        { items: [0, 11] },
      ]);
      expect(world.strippedStepInputs).toBeGreaterThan(0);
      expect(stepMessagesOf(world)).toHaveLength(3);
    });
  });
});
