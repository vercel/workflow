import { getStepMetadata } from 'workflow';
import { getHookByToken, getRun } from 'workflow/api';
import { withRateLimit } from '../patterns/rate-limiter.js';

// Module state lives in the step bundle — every step invocation in this
// file shares it, and results flow back to the test via return values.
//
// IMPORTANT: step execution is at-least-once (a step can retry after its
// side effects ran), so every counter mutation is deduped by stepId —
// otherwise a transparent runtime retry double-counts and the test lies.
let grantTimes: number[] = [];
const seenSteps = new Set<string>();

function once(stepId: string): boolean {
  if (seenSteps.has(stepId)) return false;
  seenSteps.add(stepId);
  return true;
}

async function recordGrant(): Promise<void> {
  'use step';
  const { stepId } = getStepMetadata();
  if (!once(stepId)) return;
  // Wall clock is fine inside a step (steps run in plain Node).
  grantTimes.push(Date.now());
}

async function readGrantTimes(): Promise<number[]> {
  'use step';
  return [...grantTimes];
}

async function resetStats(): Promise<void> {
  'use step';
  grantTimes = [];
  seenSteps.clear();
}

/**
 * Fan out `count` concurrent rate-limited calls; record the wall-clock
 * time at which each slot was granted (= when fn starts running).
 */
export async function rateLimitFanout(
  key: string,
  count: number,
  intervalMs: number
) {
  'use workflow';

  await resetStats();
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      withRateLimit(key, intervalMs, async () => {
        await recordGrant();
        return i;
      })
    )
  );
  const times = await readGrantTimes();
  return { results, times };
}

/** Cancel the coordinator run for `key` so tests don't leave live runs. */
export async function cancelCoordinator(token: string): Promise<boolean> {
  const hook = await getHookByToken(token).catch(() => null);
  if (!hook) return false;
  await getRun(hook.runId)
    .cancel()
    .catch(() => {});
  return true;
}
