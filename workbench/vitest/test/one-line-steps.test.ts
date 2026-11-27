import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import { oneLineStepsWorkflow } from '../workflows/one-line-steps.js';

describe('steps whose "use step" shares a line with other code', () => {
  it('runs every one-line step as a real step', async () => {
    const run = await start(oneLineStepsWorkflow, [5]);

    // Before the fix, the helper file was never discovered as a step file, so
    // the first call failed with "Step ... is not registered in the current
    // deployment" and the run failed.
    await expect(run.returnValue).resolves.toEqual({
      a: 10,
      b: 30,
      c: 31,
      d: 961,
    });

    // Each call ran as a durable step, not as a plain inline function call.
    const world = await getWorld();
    const { data } = await world.steps.list({ runId: run.runId });
    const names = data.map((s: { stepName: string }) => s.stepName).sort();
    expect(names).toHaveLength(4);
    for (const name of ['doubleIt', 'tripleIt', 'addOne', 'squareIt']) {
      expect(names.some((n: string) => n.endsWith(name))).toBe(true);
    }
    expect(
      data.every((s: { status: string }) => s.status === 'completed')
    ).toBe(true);
  });
});
