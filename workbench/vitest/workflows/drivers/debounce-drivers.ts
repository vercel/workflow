import { getHookByToken, getRun } from 'workflow/api';
import { readFired } from '../patterns/debounce.js';

// The canonical demo step (onDebounceFire) records into module state in the
// pattern file. The step bundle dedupes that module, so a step here reads
// the very same state the coordinator's fire step wrote.
async function readFiredStep(
  key: string
): Promise<Array<{ key: string; payload: unknown }>> {
  'use step';
  return readFired(key);
}

/** Read what the debounce demo action recorded for `key`. */
export async function readDebounceFired(key: string) {
  'use workflow';
  return await readFiredStep(key);
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
