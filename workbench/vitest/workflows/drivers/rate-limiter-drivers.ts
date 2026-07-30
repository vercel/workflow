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

/** Zero the shared counters. Run once before a fan-out. */
export async function resetRateLimitStats() {
  'use workflow';

  await resetStats();
}

/** Read the recorded grant times. Run once after a fan-out has settled. */
export async function readRateLimitStats() {
  'use workflow';

  return readGrantTimes();
}

/**
 * One rate-limited caller, as its own workflow run, recording the
 * wall-clock time its slot was granted (= when fn starts running).
 *
 * The fan-out is cross-run on purpose: the limiter's contract is one
 * request per interval across ALL runs and machines, which is also how
 * you'd really deploy it.
 */
export async function rateLimitCaller(
  key: string,
  intervalMs: number,
  id: number
) {
  'use workflow';

  return withRateLimit(key, intervalMs, async () => {
    await recordGrant();
    return id;
  });
}

/**
 * `count` rate-limited callers fanned out *inside one run*.
 *
 * The cross-run fan-out above is the limiter's real contract, but callers
 * do reach for `Promise.all(items.map(i => withRateLimit(...)))` to pace
 * work within a single run — so that shape has to keep working too. It is
 * also the shape that is sensitive to correlation-ID allocation order on
 * replay, which is why withRateLimit() allocates its hook and retry timer
 * in one synchronous prefix. Keep this test: it is the regression guard.
 */
export async function rateLimitInRunFanout(
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
