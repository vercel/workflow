import { getStepMetadata } from 'workflow';
import { getHookByToken, getRun } from 'workflow/api';
import { withLock, withPermit } from '../patterns/semaphore.js';

// Module state lives in the step bundle — every step invocation in this
// file shares it, and results flow back to the test via return values.
//
// IMPORTANT: step execution is at-least-once (a step can retry after its
// side effects ran), so every counter mutation is deduped by stepId —
// otherwise a transparent runtime retry double-counts and the test lies.
let inFlight = 0;
let maxInFlight = 0;
let grantOrder: number[] = [];
const seenSteps = new Set<string>();

function once(stepId: string): boolean {
  if (seenSteps.has(stepId)) return false;
  seenSteps.add(stepId);
  return true;
}

async function enterCritical(id: number): Promise<void> {
  'use step';
  const { stepId } = getStepMetadata();
  if (!once(stepId)) return;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  grantOrder.push(id);
}

async function holdBriefly(): Promise<void> {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function exitCritical(): Promise<void> {
  'use step';
  const { stepId } = getStepMetadata();
  if (!once(stepId)) return;
  inFlight--;
}

async function readStats(): Promise<{ max: number; order: number[] }> {
  'use step';
  return { max: maxInFlight, order: [...grantOrder] };
}

async function resetStats(): Promise<void> {
  'use step';
  inFlight = 0;
  maxInFlight = 0;
  grantOrder = [];
  seenSteps.clear();
}

/** Fan out `count` permit-holders; report observed max concurrency. */
export async function semaphoreFanout(
  key: string,
  count: number,
  maxConcurrent: number
) {
  'use workflow';

  await resetStats();
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      withPermit(key, maxConcurrent, async () => {
        await enterCritical(i);
        await holdBriefly();
        await exitCritical();
        return i;
      })
    )
  );
  const stats = await readStats();
  return { maxObserved: stats.max, order: stats.order };
}

/** A holder that throws — the permit must still be released. */
export async function semaphoreReleaseOnThrow(key: string) {
  'use workflow';

  await resetStats();
  const results: string[] = [];

  try {
    await withPermit(key, 1, async () => {
      throw new Error('boom');
    });
  } catch {
    results.push('threw');
  }

  // If the permit leaked, this second acquire would hang forever.
  await withPermit(key, 1, async () => {
    results.push('reacquired');
  });

  return { results };
}

/** withLock = withPermit(key, 1). */
export async function lockSerializes(key: string) {
  'use workflow';

  await resetStats();
  await Promise.all([
    withLock(key, async () => {
      await enterCritical(0);
      await holdBriefly();
      await exitCritical();
    }),
    withLock(key, async () => {
      await enterCritical(1);
      await holdBriefly();
      await exitCritical();
    }),
  ]);
  const stats = await readStats();
  return { maxObserved: stats.max };
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
