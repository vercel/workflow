import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  eventsOf,
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A lingering orchestrator resumes its retained session once per batch of
// incoming step outcomes. Every resume is a new suspension generation, and
// every step still pending signals the end of the log, so the idle polls that
// raise the next suspension (`scheduleWorkflowSuspension`) must not grow with
// generations times pending steps. They once did, and the timer count of a
// fan-out grew with roughly the cube of its width.

registerStepFunction('idle_poll_fast', async (n: number) => n);

const fanOut = `const fast = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("idle_poll_fast");
  async function workflow(n) {
    const results = await Promise.all(Array.from({ length: n }, (_, i) => fast(i)));
    return results.length;
  }${registerWorkflow()}`;

const isStepMessage = (message: unknown) =>
  (message as { stepId?: string }).stepId !== undefined;

/** Timers set while a `width`-wide fan-out runs to completion. */
async function timersForFanOut(width: number): Promise<number> {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // Every step runs from its own message, so outcomes reach the lingering
  // delivery through the live feed.
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '60000');
  const { world, start } = await setupOrchestratorRun(
    fanOut,
    [width],
    { subscribe: true, coalesce: true },
    'node'
  );
  const timers = vi.spyOn(globalThis, 'setTimeout');
  try {
    const orchestrator = world.deliver(start);
    await vi.waitFor(
      () =>
        expect(
          world.held.filter((held) => isStepMessage(held.message))
        ).toHaveLength(width),
      { timeout: 30_000, interval: 5 }
    );
    const steps = world.held.filter((held) => isStepMessage(held.message));
    // Outcomes arrive in small concurrent batches, each one a resume.
    const batch = 8;
    for (let i = 0; i < steps.length; i += batch) {
      await Promise.all(
        steps.slice(i, i + batch).map((held) => world.deliver(held))
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    await orchestrator;
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    return timers.mock.calls.length;
  } finally {
    timers.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fan-out idle polls (node engine)', () => {
  it('sets timers in proportion to the width, not to generations times pending steps', async () => {
    const narrow = 64;
    const wide = narrow * 4;
    const narrowTimers = await timersForFanOut(narrow);
    const wideTimers = await timersForFanOut(wide);
    // Linear growth gives a ratio near `wide / narrow`; one poll per pending
    // step per generation gave well over its square.
    expect(wideTimers / narrowTimers).toBeLessThan((wide / narrow) ** 2);
  }, 60_000);
});
