import { createHook } from 'workflow';

/**
 * Regression workflow for issue #2777: recreating a hook with the same
 * token after dispose() within a single run must not self-conflict.
 */
export async function reuseHookTokenWorkflow(token: string, rounds: number) {
  'use workflow';

  for (let round = 0; round < rounds; round++) {
    const hook = createHook<{ n: number }>({ token });

    const conflict = await hook.getConflict();
    if (conflict !== null) {
      return `conflict-round-${round}:${conflict.runId}`;
    }

    await hook;
    hook.dispose();
  }

  return 'ok';
}

/**
 * Regression workflow for issue #2778: a run that claims a token, receives
 * one payload, disposes, and completes must release the token claim so the
 * next run can immediately claim the same token.
 */
export async function claimTokenOnceWorkflow(token: string) {
  'use workflow';

  const hook = createHook<{ n: number }>({ token });

  const conflict = await hook.getConflict();
  if (conflict !== null) {
    return `conflict:${conflict.runId}`;
  }

  await hook;
  hook.dispose();
  return 'ok';
}
