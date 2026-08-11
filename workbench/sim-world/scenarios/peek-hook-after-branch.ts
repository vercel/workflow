import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'peek-hook-after-branch',
  name: 'peek: hook lands just AFTER the branch step commits',
  description:
    'The control. One world call later, so hook_received sits after the ' +
    'branch in the log and a replay reaching the peek still sees nothing.',
  workflow: 'hookPeekWorkflow',
  input: ['doc-9'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('step_started', 'shipWithoutApproval');
    await sim.deliverHook('peek:doc-9', { approved: true });
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: 'shipped-unapproved:reserved:doc-9',
  },
};
