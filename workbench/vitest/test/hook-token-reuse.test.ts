import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
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

  // Issue #2778: once a run disposes its hook AND COMPLETES, the token claim
  // is released, so the next run reusing the same token must claim it cleanly
  // instead of conflicting against the finished run. Each round drives its run
  // to completion before the next starts — matching the guarantee's own
  // precondition ("disposes AND completes"). An earlier version resumed and
  // immediately started the next claimant without awaiting completion; because
  // `resumeHook` only enqueues the target run's continuation (it does not wait
  // for it to process the resume + dispose), the next run could legitimately
  // observe the previous run still holding the token — a correct conflict, but
  // one that made the assertion ~10% flaky.
  it('next run can claim the token right after the previous run disposed it', async () => {
    const token = `handoff-reuse-${Math.random().toString(36).slice(2)}`;
    const rounds = 5;

    for (let round = 0; round < rounds; round++) {
      const run = await start(claimTokenOnceWorkflow, [token]);

      // The token is free (the previous round's run has completed), so this
      // run registers a hook and suspends rather than returning a conflict.
      // A regression (spurious conflict against a released claim) would resolve
      // `returnValue` first with a `conflict:*` value and fail here.
      const settled = await Promise.race([
        waitForHook(run, { token }).then(() => 'hook' as const),
        run.returnValue.then((value) => ({ value })),
      ]);
      expect(settled, `round ${round} should register a hook`).toBe('hook');

      await resumeHook(token, { n: round });
      // Wait for the run to dispose the hook and complete — releasing the
      // token claim — before the next round reuses the token.
      await expect(run.returnValue).resolves.toBe('ok');
    }
  }, 60_000);
});
