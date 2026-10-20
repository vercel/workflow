import { experimental_lock } from 'workflow';

async function criticalSection(holdMs: number): Promise<void> {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, holdMs));
}

/**
 * Takes one slot of `key`, holds it across a step, and releases it. Callers
 * namespace `key` per test so concurrent suites never contend.
 */
export async function lockFanout(
  key: string,
  concurrency: number,
  holdMs: number
): Promise<number> {
  'use workflow';
  const slot = await experimental_lock(key, { concurrency });
  try {
    await criticalSection(holdMs);
  } finally {
    slot.release();
  }
  return slot.fencingToken;
}
