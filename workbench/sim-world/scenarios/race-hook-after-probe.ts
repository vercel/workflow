import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'race-hook-after-probe',
  name: 'race: hook lands just AFTER the probe step completes',
  workflow: 'hookRaceStepWorkflow',
  input: ['doc-12'],
  script: async (sim) => {
    const probe = sim.writer.step('probe');
    await probe.runToEventCommitted('step_completed');
    await sim.deliverHook('race:doc-12', { approved: true });
    await probe.release();
  },
  expect: { status: 'completed' },
};
