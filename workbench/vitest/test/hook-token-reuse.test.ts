import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import type { Run } from 'workflow/api';
import { resumeHook, start } from 'workflow/api';
import {
  claimTokenOnceWorkflow,
  reuseHookTokenWorkflow,
} from '../workflows/hook-token-reuse.js';

describe('hook token reuse after dispose', () => {
  // Issue #2777: dispose() followed by createHook() with the same token in
  // the same run must not conflict with the run's own disposed hook.
  it('same run can recreate a hook with the same token after dispose()', async () => {
    const token = `same-run-reuse-${Math.random().toString(36).slice(2)}`;
    const rounds = 3;
    const run = await start(reuseHookTokenWorkflow, [token, rounds]);

    for (let round = 0; round < rounds; round++) {
      const settled = await Promise.race([
        waitForHook(run, { token }).then(() => 'hook' as const),
        run.returnValue.then((value) => ({ value })),
      ]);
      expect(settled, `round ${round} should register a hook`).toBe('hook');
      await resumeHook(token, { n: round });
    }

    await expect(run.returnValue).resolves.toBe('ok');
  }, 60_000);

  // Issue #2778: when run A disposes its hook and completes, run B claiming
  // the same token immediately afterwards must not conflict against run A.
  it('next run can claim the token right after the previous run disposed it', async () => {
    const token = `handoff-reuse-${Math.random().toString(36).slice(2)}`;
    const rounds = 5;
    const runs: Run<typeof claimTokenOnceWorkflow>[] = [];

    for (let round = 0; round < rounds; round++) {
      const run = await start(claimTokenOnceWorkflow, [token]);
      runs.push(run);

      const settled = await Promise.race([
        waitForHook(run, { token }).then(() => 'hook' as const),
        run.returnValue.then((value) => ({ value })),
      ]);
      expect(settled, `round ${round} should register a hook`).toBe('hook');

      // Resume the hook and immediately start the next claimant without
      // waiting for this run to settle (the "fast handoff" timing).
      await resumeHook(token, { n: round });
    }

    const results = await Promise.all(runs.map((run) => run.returnValue));
    expect(results).toEqual(Array(rounds).fill('ok'));
  }, 60_000);
});
