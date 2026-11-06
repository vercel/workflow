import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('sw_fast', async (n: number) => n + 1);
let releaseSlow: (() => void) | undefined;
registerStepFunction('sw_slow', async () => {
  await new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  return 'slow';
});
let onGate: (() => Promise<void>) | undefined;
registerStepFunction('sw_gate', async () => {
  await onGate?.();
  return 'gate';
});

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

const FAN_OUT = 64;
const fanOut = `const fast = ${step('sw_fast')};
  async function workflow(n) {
    const results = await Promise.all(Array.from({ length: n }, (_, i) => fast(i)));
    return results.length;
  }${registerWorkflow()}`;

// The gate is created first, so it takes the one inline slot and holds the
// orchestrator delivery while the fast steps run from their own messages.
const gatedFanOut = `const fast = ${step('sw_fast')}; const gate = ${step('sw_gate')};
  async function workflow(n) {
    const results = await Promise.all([
      gate(),
      ...Array.from({ length: n }, (_, i) => fast(i)),
    ]);
    return results.length;
  }${registerWorkflow()}`;

const race = `const fast = ${step('sw_fast')}; const slow = ${step('sw_slow')};
  async function workflow() {
    return await Promise.race([fast(1), slow()]);
  }${registerWorkflow()}`;

const isStepMessage = (message: unknown) =>
  (message as { stepId?: string }).stepId !== undefined;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // Every step runs from its own message.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  releaseSlow = undefined;
  onGate = undefined;
});

type HeldMessage = AppendOnlyWorld['held'][number];

/**
 * Delivers one background step message and returns what its invocation read
 * and sent: its `events.list` calls and its orchestrator messages.
 */
async function deliverStep(world: AppendOnlyWorld, held: HeldMessage) {
  const lists = world.listCalls.length;
  const sends = world.queueCalls.length;
  await world.deliver(held);
  return {
    listCalls: world.listCalls.length - lists,
    wakes: world.queueCalls
      .slice(sends)
      .filter((call) => !isStepMessage(call.message)),
  };
}

/** One plain orchestrator wake: no key, no delay, the run's spec stamped. */
function expectOnePlainWake(wakes: AppendOnlyWorld['queueCalls']) {
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.opts?.idempotencyKey).toBeUndefined();
  expect(wakes[0]?.opts?.delaySeconds).toBeUndefined();
  expect(wakes[0]?.opts?.specVersion).toEqual(expect.any(Number));
}

const heldSteps = (world: AppendOnlyWorld, stepName?: string) =>
  world.held.filter(
    (held) =>
      isStepMessage(held.message) &&
      (stepName === undefined ||
        (held.message as { stepName?: string }).stepName === stepName)
  );

describe.each([
  'node',
  'quickjs',
] as const)('orchestrator wakes after background steps (%s engine)', (engine) => {
  it('wakes once per completion without reading the log', async () => {
    const { world } = await setupOrchestratorRun(fanOut, [FAN_OUT], {}, engine);
    await world.deliver(world.held[0]!);
    const steps = heldSteps(world);
    expect(steps).toHaveLength(FAN_OUT);
    for (const held of steps) {
      const { listCalls, wakes } = await deliverStep(world, held);
      expect(listCalls).toBe(0);
      expectOnePlainWake(wakes);
    }
    await world.runUntilIdle(4 * FAN_OUT);

    expect(await runResult(world)).toBe(FAN_OUT);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
  });

  it('coalesces the wakes of a fan-out into the running orchestrator delivery', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    const { world } = await setupOrchestratorRun(
      gatedFanOut,
      [FAN_OUT],
      { coalesce: true },
      engine
    );
    let gateReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      gateReached = resolve;
    });
    let releaseGate!: () => void;
    onGate = async () => {
      gateReached();
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    };
    const orchestrator = world.deliver(world.held[0]!);
    await reached;
    // The background steps' messages go out once every creation committed,
    // while the inline body holds the delivery.
    await vi.waitFor(() => expect(heldSteps(world)).toHaveLength(FAN_OUT));
    for (const held of heldSteps(world)) {
      const { listCalls, wakes } = await deliverStep(world, held);
      expect(listCalls).toBe(0);
      expectOnePlainWake(wakes);
    }
    // Every wake was folded into the delivery that holds the run.
    expect(world.coalescedMessages).toBe(FAN_OUT);
    releaseGate();
    await orchestrator;
    await world.runUntilIdle(4 * FAN_OUT);

    expect(await runResult(world)).toBe(FAN_OUT + 1);
    expect(
      world.deliveries.filter((delivery) => !isStepMessage(delivery.message))
        .length
    ).toBeLessThanOrEqual(2);
  });

  it('wakes a race that one branch decides while the other is pending', async () => {
    const { world } = await setupOrchestratorRun(race, [], {}, engine);
    await world.deliver(world.held[0]!);
    const [fastMessage] = heldSteps(world, 'sw_fast');
    expect(fastMessage).toBeDefined();
    const { listCalls, wakes } = await deliverStep(world, fastMessage!);
    expect(listCalls).toBe(0);
    expectOnePlainWake(wakes);
    const wake = world.held.find((held) => !isStepMessage(held.message));
    await world.deliver(wake!);
    expect(await runResult(world)).toBe(2);
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);
  });

  it('acknowledges the wake of a completion that lands after the run finished', async () => {
    const { world } = await setupOrchestratorRun(race, [], {}, engine);
    await world.deliver(world.held[0]!);
    const [slowMessage] = heldSteps(world, 'sw_slow');
    const [fastMessage] = heldSteps(world, 'sw_fast');
    const slow = deliverStep(world, slowMessage!);
    await vi.waitFor(() => expect(releaseSlow).toBeDefined());
    await deliverStep(world, fastMessage!);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(2);

    // The orchestrator's own reads ran while the slow body was held, so
    // only what the step reads after its body counts here.
    const listsBeforeOutcome = world.listCalls.length;
    const sendsBeforeOutcome = world.queueCalls.length;
    releaseSlow?.();
    await slow;
    expect(world.listCalls.length).toBe(listsBeforeOutcome);
    expect(eventsOf(world, 'step_completed')).toHaveLength(2);
    expectOnePlainWake(
      world.queueCalls
        .slice(sendsBeforeOutcome)
        .filter((call) => !isStepMessage(call.message))
    );
    const eventCount = world.events.length;
    await world.runUntilIdle();
    // The finished run's orchestrator takes the wake and writes nothing.
    expect(world.held).toHaveLength(0);
    expect(world.events).toHaveLength(eventCount);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(await runResult(world)).toBe(2);
  });
});
