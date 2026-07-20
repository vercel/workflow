async function tick(i: number): Promise<number> {
  'use step';
  return i;
}

/**
 * Runaway workflow: creates far more events than a low `WORKFLOW_MAX_EVENTS`
 * ceiling allows. With the limit set low (and turbo disabled so the runtime
 * reads `maxEvents` off the run_started response), the event-limit guard fails
 * the run with MAX_EVENTS_EXCEEDED before the loop finishes — so the 100
 * iterations never all run.
 */
export async function runawayWorkflow(): Promise<number> {
  'use workflow';
  let total = 0;
  for (let i = 0; i < 100; i++) {
    total += await tick(i);
  }
  return total;
}
