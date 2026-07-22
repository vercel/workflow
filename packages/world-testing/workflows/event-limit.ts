async function tick(i: number): Promise<number> {
  'use step';
  return i;
}

/**
 * Runaway workflow: creates far more events than a low `WORKFLOW_MAX_EVENTS`
 * ceiling, so the event-limit guard fails it before the loop finishes.
 */
export async function runawayWorkflow(): Promise<number> {
  'use workflow';
  let total = 0;
  for (let i = 0; i < 15; i++) {
    total += await tick(i);
  }
  return total;
}
