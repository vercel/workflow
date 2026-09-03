import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'cancel-mid-step',
  name: 'cancellation lands mid-step',
  description:
    'The run is cancelled inside the step_started commit, so the step body ' +
    'runs against an already-terminal run and its step_completed is the only ' +
    'write the world still accepts.',
  workflow: 'approvalWorkflow',
  input: ['doc-5'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('step_started', 'reserveInventory');
    await sim.cancelRun('operator pulled the plug');
    await wf.release();
  },
  expect: { status: 'cancelled' },
};
