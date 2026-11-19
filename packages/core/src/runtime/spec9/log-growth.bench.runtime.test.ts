/**
 * Milliseconds per inline step at 250 against 2000 sequential steps on the
 * node engine, in one delivery on the in-memory World: how the orchestrator's
 * own per-write work grows with the log (spec 9 follow-up 6). Opt-in, since a
 * timing is not a pass/fail signal on a shared runner:
 *
 *   WORKFLOW_LOG_GROWTH_BENCH=1 pnpm vitest run src/runtime/spec9/log-growth.bench.runtime.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('bench_add', async (x: number) => x + 1);

const code = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("bench_add");
  async function workflow(n) {
    let x = 0;
    for (let i = 0; i < n; i++) x = await add(x);
    return x;
  }${registerWorkflow()}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function msPerStep(steps: number): Promise<number> {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', String(60 * 60_000));
  vi.stubEnv('WORKFLOW_REPLAY_TIMEOUT_MS', String(60 * 60_000));
  const { world, start } = await setupOrchestratorRun(code, [steps], {
    fence: true,
  });
  const startedAt = performance.now();
  await world.deliver(start);
  const elapsed = performance.now() - startedAt;
  expect(await runResult(world)).toBe(steps);
  expect(eventsOf(world, 'step_completed')).toHaveLength(steps);
  return elapsed / steps;
}

describe.runIf(process.env.WORKFLOW_LOG_GROWTH_BENCH === '1')(
  'orchestrator ms per inline step as the log grows (node engine)',
  () => {
    it('measures 250 against 2000 sequential steps', async () => {
      await msPerStep(50); // warm-up
      const small = process.env.BENCH_ONLY_LARGE ? 1 : await msPerStep(250);
      const large = await msPerStep(2000);
      process.stderr.write(
        `[log-growth] ms/step: 250 steps ${small.toFixed(3)}, 2000 steps ${large.toFixed(3)}, ratio ${(large / small).toFixed(2)}\n`
      );
    }, 600_000);
  }
);
