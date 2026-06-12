import { getStepMetadata } from 'workflow';
import { getHookByToken, getRun } from 'workflow/api';
import { withBreaker } from '../patterns/circuit-breaker.js';

// Module state lives in the step bundle — every step invocation in this
// file shares it, and results flow back to the test via return values.
//
// IMPORTANT: step execution is at-least-once (a step can retry after its
// side effects ran), so every counter mutation is deduped by stepId —
// otherwise a transparent runtime retry double-counts and the test lies.
let fnCalls: string[] = [];
const seenSteps = new Set<string>();

function once(stepId: string): boolean {
  if (seenSteps.has(stepId)) return false;
  seenSteps.add(stepId);
  return true;
}

async function recordFnCall(label: string): Promise<void> {
  'use step';
  const { stepId } = getStepMetadata();
  if (!once(stepId)) return;
  fnCalls.push(label);
}

async function readFnCalls(): Promise<string[]> {
  'use step';
  return [...fnCalls];
}

async function resetStats(): Promise<void> {
  'use step';
  fnCalls = [];
  seenSteps.clear();
}

// One withBreaker attempt. The error is thrown in workflow context (not in
// a step) so there are no step retries to wait through. Outcomes:
//   'ok'     — fn ran and succeeded
//   'failed' — fn ran and threw (reported to the breaker)
//   'open'   — rejected with CircuitOpenError, fn did NOT run
async function attempt(
  key: string,
  label: string,
  shouldFail: boolean
): Promise<string> {
  try {
    await withBreaker(key, async () => {
      await recordFnCall(label);
      if (shouldFail) throw new Error('boom');
    });
    return 'ok';
  } catch (err) {
    return (err as Error).name === 'CircuitOpenError' ? 'open' : 'failed';
  }
}

/** `count` sequential failing calls; returns outcomes + which fns ran. */
export async function breakerFailures(key: string, count: number) {
  'use workflow';

  await resetStats();
  const outcomes: string[] = [];
  for (let i = 0; i < count; i++) {
    outcomes.push(await attempt(key, `fail-${i}`, true));
  }
  const calls = await readFnCalls();
  return { outcomes, calls };
}

/**
 * 4 failures, 1 success, 4 failures, then a final call. The success resets
 * the consecutive-failure count, so the breaker never trips (threshold 5).
 */
export async function breakerInterleaved(key: string) {
  'use workflow';

  await resetStats();
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) {
    outcomes.push(await attempt(key, `f1-${i}`, true));
  }
  outcomes.push(await attempt(key, 'ok-mid', false));
  for (let i = 0; i < 4; i++) {
    outcomes.push(await attempt(key, `f2-${i}`, true));
  }
  outcomes.push(await attempt(key, 'final', false));
  const calls = await readFnCalls();
  return { outcomes, calls };
}

/** A single call; returns its outcome + all fn labels seen so far. */
export async function breakerSingleCall(
  key: string,
  label: string,
  shouldFail: boolean
) {
  'use workflow';

  const outcome = await attempt(key, label, shouldFail);
  const calls = await readFnCalls();
  return { outcome, calls };
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
