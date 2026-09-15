import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'hook-at-hook-created',
  name: 'hook arrives the instant it is registered',
  description:
    'Delivered inside the hook_created commit, before the workflow has even ' +
    'been resumed to schedule the step it runs in parallel with.',
  workflow: 'approvalWorkflow',
  input: ['doc-1'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('hook_created', {
      token: 'approval:doc-1',
    });
    await sim.deliverHook('approval:doc-1', {
      approved: false,
      reviewer: 'grace',
    });
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: { status: 'released:reserved:doc-1', reviewer: 'grace' },
  },
};
