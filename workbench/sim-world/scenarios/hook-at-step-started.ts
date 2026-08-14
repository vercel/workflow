import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'hook-at-step-started',
  name: 'hook arrives inside the step_started commit',
  description:
    'The hook payload is written after step_started is durable and before ' +
    'the workflow is resumed, so hook_received precedes step_completed in the log.',
  workflow: 'approvalWorkflow',
  input: ['doc-1'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('step_started', 'reserveInventory');
    await sim.deliverHook('approval:doc-1', {
      approved: true,
      reviewer: 'ada',
    });
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: { status: 'settled:reserved:doc-1', reviewer: 'ada' },
  },
};
