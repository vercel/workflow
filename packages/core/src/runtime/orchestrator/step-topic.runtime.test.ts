import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('st_inc', async (n: number) => n + 1);

const FAN_OUT = 8;
const fanOut = `const inc = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("st_inc");
  async function workflow(n) {
    const results = await Promise.all(Array.from({ length: n }, (_, i) => inc(i)));
    return results.length;
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
});

describe.each([
  'node',
  'quickjs',
] as const)('the step-execution topic (%s engine)', (engine) => {
  // The generated route passes `stepTopic` when the build registered the
  // step trigger: only background step messages carry it.
  it('marks step messages, and only them, when the route registered the step trigger', async () => {
    const { world } = await setupOrchestratorRun(fanOut, [FAN_OUT], {}, engine);
    await workflowEntrypoint(fanOut, { stepTopic: true })(
      new Request('https://example.test')
    );
    await world.runUntilIdle(4 * FAN_OUT);

    expect(await runResult(world)).toBe(FAN_OUT);
    const steps = world.queueCalls.filter((c) => isStepMessage(c.message));
    const others = world.queueCalls.filter((c) => !isStepMessage(c.message));
    expect(steps).toHaveLength(FAN_OUT);
    expect(steps.every((c) => c.opts?.stepTopic === true)).toBe(true);
    expect(others.length).toBeGreaterThan(0);
    expect(others.some((c) => c.opts?.stepTopic !== undefined)).toBe(false);
  });

  it('leaves step messages unmarked without it', async () => {
    const { world } = await setupOrchestratorRun(fanOut, [FAN_OUT], {}, engine);
    await world.runUntilIdle(4 * FAN_OUT);

    expect(await runResult(world)).toBe(FAN_OUT);
    expect(world.queueCalls.some((c) => c.opts?.stepTopic !== undefined)).toBe(
      false
    );
  });
});
