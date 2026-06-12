import { cancellableSleep, executedActions } from '../patterns/scheduling.js';

// Module state (`executedActions`) lives in the step bundle, so a step in
// this file reads the same Map the canonical runAction step wrote to.
async function readExecuted(
  id: string
): Promise<Record<string, unknown> | null> {
  'use step';
  return executedActions.get(id) ?? null;
}

/** Read back what the demo runAction recorded for a schedule id. */
export async function readExecutedAction(id: string) {
  'use workflow';
  return await readExecuted(id);
}

/** Drive the reusable cancellableSleep component directly. */
export async function cancellableSleepDriver(
  token: string,
  delay: string | number
) {
  'use workflow';
  const outcome = await cancellableSleep(token, delay);
  return { outcome };
}
