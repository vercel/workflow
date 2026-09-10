import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'hook-at-step-completed',
  name: 'hook arrives inside the step_completed commit',
  description:
    'Same workflow and same result, but hook_received now lands after ' +
    'step_completed. Diff this event stream against the previous scenario. ' +
    'Note the writer: the result is committed by the step body, not by the ' +
    'orchestrator.',
  workflow: 'approvalWorkflow',
  input: ['doc-1'],
  script: async (sim) => {
    const reserve = sim.writer.step('reserveInventory');
    await reserve.runToEventCommitted('step_completed');
    await sim.deliverHook('approval:doc-1', {
      approved: true,
      reviewer: 'ada',
    });
    await reserve.release();
  },
  expect: {
    status: 'completed',
    output: { status: 'settled:reserved:doc-1', reviewer: 'ada' },
  },
};
