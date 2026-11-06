/**
 * A background step's message is exempt from the run's delivery cap, since
 * it is redelivered on purpose while the step retries in place. A message
 * whose every delivery throws before writing anything is not retrying,
 * though: past the cap, the step is failed so the workflow can handle it.
 */
import { RUN_ERROR_CODES } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import type {
  AppendOnlyWorld,
  HeldMessage,
} from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { getMaxQueueDeliveries } from '../constants.js';
import { setWorld } from '../world.js';
import { STEP_DELIVERY_STALL_WINDOW_MS } from './step-delivery.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

let bodyRuns = 0;
registerStepFunction('cap_unreadable', async () => {
  bodyRuns++;
  return 'ran';
});

const catchingWorkflow = `const unreadable = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("cap_unreadable");
  async function workflow() {
    try {
      return await unreadable();
    } catch (error) {
      return "caught: " + error.message;
    }
  }${registerWorkflow()}`;

const isStepMessage = (held: HeldMessage) =>
  (held.message as { stepId?: string }).stepId !== undefined;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // The step runs from its own message.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
  bodyRuns = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setWorld(undefined);
});

/**
 * Makes every read of the step's input fail: its message carries none, and
 * the World cannot serve its creation event.
 */
function makeStepInputUnreadable(world: AppendOnlyWorld): void {
  const asWorld = world.asWorld();
  const queue = asWorld.queue.bind(asWorld);
  asWorld.queue = (async (name, message, opts) => {
    const { stepInput: _input, ...rest } = message as Record<string, unknown>;
    return queue(name, rest as typeof message, opts);
  }) as typeof asWorld.queue;
  asWorld.events.get = async () => {
    throw new Error('event read failed');
  };
  setWorld(asWorld);
}

describe.each([
  'node',
  'quickjs',
] as const)('a step message past the delivery cap (%s engine)', (engine) => {
  it('fails the step with MAX_DELIVERIES_EXCEEDED once no delivery got it started, and the workflow catches it', async () => {
    const maxDeliveries = getMaxQueueDeliveries();
    const { world, start } = await setupOrchestratorRun(
      catchingWorkflow,
      [],
      {},
      engine
    );
    makeStepInputUnreadable(world);
    const warn = vi.spyOn(runtimeLogger, 'warn');

    await world.deliver(start);
    const stepMessage = () => world.held.find(isStepMessage);
    expect(stepMessage()).toBeDefined();

    // Every delivery up to the cap throws, and so does the first past it
    // while the step's creation is recent.
    for (let delivery = 1; delivery <= maxDeliveries + 1; delivery++) {
      await expect(world.deliver(stepMessage()!)).rejects.toThrow();
    }
    expect(eventsOf(world, 'step_failed')).toHaveLength(0);

    // Long after the creation, still nothing started: the step fails.
    vi.setSystemTime(Date.now() + STEP_DELIVERY_STALL_WINDOW_MS + 1);
    expect(await world.deliver(stepMessage()!)).toBeUndefined();
    expect(stepMessage()).toBeUndefined();
    expect(eventsOf(world, 'step_started')).toHaveLength(0);
    expect(eventsOf(world, 'step_failed')).toHaveLength(1);
    expect(bodyRuns).toBe(0);

    await world.runUntilIdle();
    const result = await runResult(world);
    expect(result).toMatch(/^caught: /);
    expect(result).toContain(RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED);

    // Past the cap, once at the first delivery and once per power of two.
    const pastCapWarnings = warn.mock.calls.filter(
      ([message]) => message === 'Step message delivered past max deliveries'
    );
    expect(pastCapWarnings.map(([, fields]) => fields?.attempt)).toEqual([
      maxDeliveries + 1,
      maxDeliveries + 2,
    ]);
  });

  it('runs a step past the cap whose log shows recent activity', async () => {
    const maxDeliveries = getMaxQueueDeliveries();
    const { world, start } = await setupOrchestratorRun(
      catchingWorkflow,
      [],
      {},
      engine
    );
    await world.deliver(start);
    const [stepMessage] = world.held.filter(isStepMessage);
    // A message delivered past the cap (its earlier deliveries deferred,
    // say) whose step was created recently runs its body as before.
    await world.deliver({ ...stepMessage!, deliveryCount: maxDeliveries + 5 });
    expect(bodyRuns).toBe(1);
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe('ran');
  });
});
