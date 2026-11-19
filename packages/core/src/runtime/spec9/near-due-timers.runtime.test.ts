/**
 * The timers a fan-out of short sleeps costs when nothing coalesces its
 * orchestrator messages and no live feed carries step outcomes (world-local,
 * world-postgres, or world-vercel without the push transport): each step
 * outcome wakes the run in its own delivery. A suspending delivery arms the
 * waits due within the near-due window whatever chain they are in
 * (`getNearDueWaitWindowSeconds`), and that must stay a bounded cost per
 * wait, not one timer per wait per delivery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import type { HeldMessage } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { getNearDueWaitWindowSeconds } from '../wait-continuation.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('near_due_step', async (n: number) => n);

/** Seconds each branch sleeps: within the near-due window once it is created. */
const SLEEP_SECONDS = 3;

const fanOutThenSleep = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("near_due_step");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(n) {
    const done = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        await step(i);
        await sleep("${SLEEP_SECONDS}s");
        return i;
      })
    );
    return done.length;
  }${registerWorkflow()}`;

const isTimer = (message: unknown) =>
  (message as { waitContinuation?: unknown }).waitContinuation !== undefined;
const isStep = (message: unknown) =>
  (message as { stepId?: unknown }).stepId !== undefined;

type Order =
  /** Each step outcome's wake is delivered before the next step runs. */
  | 'one-outcome-per-delivery'
  /** Every step runs before the first wake. */
  | 'outcomes-first'
  /**
   * As `one-outcome-per-delivery`, with every orchestrator delivery a
   * coalesced re-run, as world-vercel reports one: each may hold a timer the
   * queue coalesced into it, so each arms every near-due wait.
   */
  | 'coalesced-reruns'
  /** As `coalesced-reruns`, with each delivery a quarter second later. */
  | 'coalesced-reruns-on-a-moving-clock';

/**
 * Runs a `width`-wide fan-out of `step(i); sleep()` to completion on a
 * clock that honours message delays, and counts its timers: the sends the
 * runtime made, and the timer messages the queue delivered (a keyed send the
 * queue deduplicated is never delivered).
 */
async function timersOf(
  engine: 'node' | 'quickjs',
  width: number,
  order: Order
) {
  const { world } = await setupOrchestratorRun(
    fanOutThenSleep,
    [width],
    {},
    engine
  );
  await world.runOnClock({
    prefer: (held: HeldMessage) =>
      order === 'outcomes-first' ? isStep(held.message) : !isStep(held.message),
    ...(order.startsWith('coalesced-reruns')
      ? {
          deliverAs: (held: HeldMessage) => {
            if (order === 'coalesced-reruns-on-a-moving-clock') {
              vi.setSystemTime(Date.now() + 250);
            }
            return isStep(held.message) ? held : { ...held, coalescedRerun: 1 };
          },
        }
      : {}),
  });
  expect(eventsOf(world, 'run_completed')).toHaveLength(1);
  expect(await runResult(world)).toBe(width);
  expect(eventsOf(world, 'wait_completed')).toHaveLength(width);
  return {
    sent: world.queueCalls.filter((call) => isTimer(call.message)).length,
    delivered: world.deliveries.filter((delivery) => isTimer(delivery.message))
      .length,
    deliveries: world.deliveries.length,
  };
}

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // Every step runs from its own message.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('near-due wait timers of a fan-out (%s engine)', (engine) => {
  it.each([
    'one-outcome-per-delivery',
    'outcomes-first',
    'coalesced-reruns',
    'coalesced-reruns-on-a-moving-clock',
  ] as const)('delivers timers in proportion to the width (%s)', async (order) => {
    const narrow = 20;
    const wide = 2 * narrow;
    for (const width of [narrow, wide]) {
      const counts = await timersOf(engine, width, order);
      if (order === 'coalesced-reruns-on-a-moving-clock') {
        // One re-arm per wait for each second of the sender's clock in
        // which the wait is near-due, at most.
        const perWait = getNearDueWaitWindowSeconds() + 1;
        expect(counts.sent).toBeLessThanOrEqual(perWait * width);
        expect(counts.delivered).toBeLessThanOrEqual(perWait * width);
        continue;
      }
      // At most one timer per wait from the delivery that owns its chain,
      // and one from the near-due safety net.
      expect(counts.sent).toBeLessThanOrEqual(2 * width);
      expect(counts.delivered).toBeLessThanOrEqual(2 * width);
      if (!order.startsWith('coalesced-reruns')) {
        // A first delivery holds no coalesced timer and re-arms nothing.
        expect(counts.sent).toBeLessThanOrEqual(width);
      }
    }
  }, 60_000);
});
