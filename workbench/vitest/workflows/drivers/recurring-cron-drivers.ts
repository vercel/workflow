import { cronTicks } from '../patterns/recurring-cron.js';

// Module state (`cronTicks`) lives in the step bundle, so a step in this
// file reads the same Map the canonical runJob step wrote to.
async function readTicks(
  name: string
): Promise<{ iteration: number; dueAt: number }[]> {
  'use step';
  return cronTicks.get(name) ?? [];
}

/** Read back the ticks the demo runJob recorded for a cron name. */
export async function readCronTicks(name: string) {
  'use workflow';
  return await readTicks(name);
}
