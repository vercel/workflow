import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { runAsInlineDeliveryForTests } from '../inline-orchestrator.js';
import {
  __unregisterQuickJSEngineForTests,
  registerQuickJSEngine,
} from '../quickjs-loader.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

let ran = 0;
registerStepFunction('qme_step', async (n: number) => {
  ran++;
  return n + 1;
});

const code = `const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("qme_step");
  async function workflow(n) { return await s(n); }${registerWorkflow()}`;

afterEach(() => {
  ran = 0;
});

/**
 * A QuickJS run that reaches a function without the QuickJS engine (an inline
 * delivery in a route whose per-workflow entry leaves the engine out, when a
 * resume could not tell the run's engine in advance) is handed back to the
 * queue, and the flow route, which has the engine, finishes it.
 */
describe('a QuickJS run where the engine is not bundled', () => {
  it('is handed off untouched, and completes where the engine is', async () => {
    const { world, start } = await setupOrchestratorRun(
      code,
      [1],
      {},
      'quickjs'
    );
    const engine = __unregisterQuickJSEngineForTests();
    expect(engine).toBeDefined();
    let first: unknown;
    try {
      first = await runAsInlineDeliveryForTests(() => world.deliver(start));
    } finally {
      if (engine) registerQuickJSEngine(engine);
    }

    // A handoff: the same message, delivered again, with nothing run here.
    expect(first).toEqual({ timeoutSeconds: 0 });
    expect(ran).toBe(0);
    expect(eventsOf(world, 'step_started')).toHaveLength(0);
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);

    await world.runUntilIdle();
    expect(ran).toBe(1);
    expect(await runResult(world)).toBe(2);
  });

  it('is not handed off outside an inline delivery: the flow route must have the engine', async () => {
    const { world, start } = await setupOrchestratorRun(
      code,
      [1],
      {},
      'quickjs'
    );
    const engine = __unregisterQuickJSEngineForTests();
    try {
      // A missing engine in the flow route is a bundling bug: handing off
      // would only loop, so the delivery fails and the queue retries it.
      await expect(world.deliver(start)).rejects.toThrow(/QuickJS/);
    } finally {
      if (engine) registerQuickJSEngine(engine);
    }
    expect(ran).toBe(0);
  });
});
