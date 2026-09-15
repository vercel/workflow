/**
 * The writer layer's guarantees, pinned against the inert handler.
 *
 * Three of them matter enough to test directly, because each one is a way the
 * termination guarantee could be lost:
 *
 *  - a point that has already gone by must be an error, not a wait;
 *  - a point that will never arrive must time out with a diagnosis naming the
 *    writer, not consume the scenario's whole wall-clock budget;
 *  - re-advancing a writer must release the call it was holding, or the second
 *    `runTo` waits behind a call that nobody let go of.
 */

import { describe, expect, it } from 'vitest';
import { runScenario, type ScenarioSpec } from './scenario.js';

/** A flow handler that accepts every delivery and advances nothing. */
const inertHandler = async () => Response.json({ ok: true });

const WORKFLOW_ID = 'workflow//./workflows/demo//demoWorkflow';

function scenario(partial: Partial<ScenarioSpec>): ScenarioSpec {
  return {
    name: 'test',
    workflow: { workflowId: WORKFLOW_ID },
    limits: { maxWallMs: 1_000 },
    ...partial,
  };
}

describe('writer runTo', () => {
  it('holds the call that produced the event, before it is committed', async () => {
    let eventsWhileHeld: number | undefined;
    await runScenario(
      scenario({
        script: async (sim) => {
          const wf = sim.writer.orchestrator();
          const held = await wf.runToEventProduced('run_created');
          // `produced` is the `before` phase: the write has been decided but
          // the log does not have it yet.
          eventsWhileHeld = sim.world.events().length;
          await held.release();
        },
      }),
      { handler: inertHandler }
    );
    expect(eventsWhileHeld).toBe(0);
  });

  it('holds after the commit for `committed`', async () => {
    let seen: string[] = [];
    await runScenario(
      scenario({
        script: async (sim) => {
          const wf = sim.writer.orchestrator();
          await wf.runToEventCommitted('run_created');
          seen = sim.world
            .events()
            .map((e: { eventType: string }) => e.eventType);
          await wf.release();
        },
      }),
      { handler: inertHandler }
    );
    expect(seen).toEqual(['run_created']);
  });

  it('reports a point the writer sailed past instead of waiting for it', async () => {
    const result = await runScenario(
      scenario({
        script: async (sim) => {
          const wf = sim.writer.orchestrator();
          // Stop before the commit, then let go: the commit happens while the
          // script is not watching for it, so asking for it now is the
          // arm-too-late mistake, and it must be reported as one.
          const held = await wf.runToEventProduced('run_created');
          await held.release();
          await wf.runToEventCommitted('run_created');
        },
      }),
      { handler: inertHandler }
    );

    expect(result.ok).toBe(false);
    const text = result.problems.join('\n');
    // The point is named, so the failure says what happened rather than only
    // that something did not.
    expect(text).toMatch(/already passed run_created \(committed\)/);
    // And it explains the fix, since the fix is not obvious.
    expect(text).toMatch(/level-triggered/);
  });

  it('times out one runTo without spending the scenario budget', async () => {
    const result = await runScenario(
      scenario({
        limits: { maxWallMs: 5_000, maxRunToWallMs: 200 },
        script: async (sim) => {
          const wf = sim.writer.orchestrator();
          // Hold the scheduler so the scenario cannot end on its own, then wait
          // for something the inert handler will never do.
          const held = await wf.runToEventProduced('run_created');
          try {
            await sim.writer
              .step('never')
              .runToEventCommitted('step_completed');
          } finally {
            await held.release();
          }
        },
      }),
      { handler: inertHandler }
    );

    expect(result.ok).toBe(false);
    const text = result.problems.join('\n');
    expect(text).toMatch(/step:never did not reach step_completed/);
    // The report says where every writer was standing, which is the whole
    // reason this budget exists separately from the global one.
    expect(text).toMatch(/orchestrator HELD at/);
    // The specific diagnosis won, and the global deadline never fired.
    expect(text).not.toMatch(/wall-clock budget/);
    expect(result.wallMs).toBeLessThan(4_000);
  });

  it('releases the previous hold when the writer is advanced again', async () => {
    let events: string[] = [];
    const result = await runScenario(
      scenario({
        script: async (sim) => {
          const wf = sim.writer.orchestrator();
          await wf.runToEventProduced('run_created');
          // No explicit release: the next advance must let the call finish,
          // otherwise this second wait blocks behind a call nobody let go of.
          await wf.runToEventCommitted('run_created');
          events = sim.world
            .events()
            .map((e: { eventType: string }) => e.eventType);
          await wf.release();
        },
      }),
      { handler: inertHandler }
    );

    expect(events).toEqual(['run_created']);
    expect(result.problems.filter((p) => p.includes('script'))).toEqual([]);
    expect(result.outcome).toBe('stalled'); // the inert run makes no progress
  });

  it('names the writers it has seen', async () => {
    let seen: string[] = [];
    await runScenario(
      scenario({
        script: async (sim) => {
          const wf = sim.writer.orchestrator();
          await wf.runToEventCommitted('run_created');
          seen = sim.writer.seen();
          await wf.release();
        },
      }),
      { handler: inertHandler }
    );
    expect(seen).toContain('orchestrator');
  });
});
