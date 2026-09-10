/**
 * The imperative scripting layer is the one part of the simulator that can
 * hang: a parked call blocks the scheduler, so a script waiting for something
 * that never happens has no quiescence to fall back on. These tests pin the
 * guards that turn each such case back into a reported failure.
 *
 * They drive `runScenario` against a handler that acknowledges deliveries
 * without doing any work, so the run makes no progress and every wait a script
 * could express is one that will never be satisfied.
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

describe('tempo scripts', () => {
  it('reports a script still waiting instead of hanging', async () => {
    const result = await runScenario(
      scenario({
        script: async (sim) => {
          // Nothing ever commits a step_started against the inert handler.
          await sim.park({ eventType: 'step_started' });
        },
      }),
      { handler: inertHandler }
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(
      /script never finished — waiting for "park step_started"/
    );
    // The run itself is diagnosed independently: the queue drained with the
    // run still going.
    expect(result.outcome).toBe('stalled');
  });

  it('breaks a parked call on the wall-clock deadline', async () => {
    const started = performance.now();
    const result = await runScenario(
      scenario({
        limits: { maxWallMs: 250 },
        script: async (sim) => {
          // Park on the very first world call and never release it. Without
          // the deadline this deadlocks the scheduler permanently.
          const parked = await sim.park({ eventType: 'run_created' });
          await new Promise(() => {});
          parked.release();
        },
      }),
      { handler: inertHandler }
    );

    expect(result.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.problems.join('\n')).toMatch(/wall-clock budget/);
  });

  it('runs a script that parks, acts and releases', async () => {
    const observed: string[] = [];
    const result = await runScenario(
      scenario({
        script: async (sim) => {
          const parked = await sim.park({ eventType: 'run_created' });
          // The world call has committed but not returned: the event is in
          // the log and `start()` has not been resumed.
          observed.push(
            ...sim.world.events().map((e: { eventType: string }) => e.eventType)
          );
          parked.release();
        },
      }),
      { handler: inertHandler }
    );

    expect(observed).toEqual(['run_created']);
    // No script problems — only the run's own stall.
    expect(result.problems.filter((p) => p.includes('script'))).toEqual([]);
  });

  it('surfaces a script failure as a scenario problem, not a world error', async () => {
    const result = await runScenario(
      scenario({
        script: async (sim) => {
          const parked = await sim.park({ eventType: 'run_created' });
          parked.release();
          throw new Error('assertion in script');
        },
      }),
      { handler: inertHandler }
    );

    expect(result.problems.join('\n')).toMatch(
      /script threw: assertion in script/
    );
    // The run was not derailed by the script's failure.
    expect(result.outcome).toBe('stalled');
  });

  it('releases a parked call exactly once, even if the script double-releases', async () => {
    const result = await runScenario(
      scenario({
        script: async (sim) => {
          const parked = await sim.park({ eventType: 'run_created' });
          parked.release();
          parked.release();
        },
      }),
      { handler: inertHandler }
    );

    expect(result.problems.filter((p) => p.includes('script'))).toEqual([]);
  });

  it('lets `during` scope the hold to a block', async () => {
    let heldEvents = 0;
    await runScenario(
      scenario({
        script: async (sim) => {
          await sim.during({ eventType: 'run_created' }, () => {
            heldEvents = sim.world.events().length;
          });
        },
      }),
      { handler: inertHandler }
    );
    expect(heldEvents).toBe(1);
  });
});

describe('delivery order', () => {
  it('lets a scenario override which message is delivered next', async () => {
    const seen: string[] = [];
    await runScenario(
      scenario({
        selectNext: (pending) => {
          seen.push(...pending.map((m) => m.messageId));
          // Deliberately pick the last pending message rather than the first.
          return pending.at(-1)?.messageId;
        },
      }),
      { handler: inertHandler }
    );
    // start() enqueues exactly one message, so the override is exercised even
    // though the choice is forced.
    expect(seen.length).toBeGreaterThan(0);
  });

  it('falls back to the default order when the choice is not pending', async () => {
    const result = await runScenario(
      scenario({ selectNext: () => 'msg_does_not_exist' }),
      { handler: inertHandler }
    );
    expect(
      result.trace.some(
        (t) => t.kind === 'warn' && t.message.includes('is not pending')
      )
    ).toBe(true);
    // The message still got delivered via the default path.
    expect(result.deliveries).toBe(1);
  });
});
