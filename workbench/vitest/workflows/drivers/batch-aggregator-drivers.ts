import { getHookByToken, getRun } from 'workflow/api';
import { readFlushes } from '../patterns/batch-aggregator.js';

// The canonical demo step (flushBatch) records into module state in the
// pattern file. The step bundle dedupes that module, so a step here reads
// the very same state the coordinator's flush step wrote.
async function readFlushesStep(key: string): Promise<
  Array<{
    key: string;
    reason: 'size' | 'deadline';
    items: unknown[];
  }>
> {
  'use step';
  return readFlushes(key);
}

/** Read what the aggregator demo flush recorded for `key`. */
export async function readAggregatorFlushes(key: string) {
  'use workflow';
  return await readFlushesStep(key);
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
