import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'race-hook-before-probe',
  name: 'race: hook lands just BEFORE the probe step completes',
  description:
    'Both branches of the race are event-log deliveries now, so the winner ' +
    'is decided by delivery-barrier ordering — and the script puts ' +
    'hook_received ahead of the step result in the log by holding the step ' +
    'body at the point where it has decided to write and has not yet.',
  workflow: 'hookRaceStepWorkflow',
  input: ['doc-11'],
  script: async (sim) => {
    const probe = sim.writer.step('probe');
    await probe.runToEventProduced('step_completed');
    await sim.deliverHook('race:doc-11', { approved: true });
    await probe.release();
  },
  expect: { status: 'completed' },
};
