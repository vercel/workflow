import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'peek-hook-before-branch',
  name: 'peek: hook lands just BEFORE the branch step commits',
  description:
    'The first execution peeks, sees nothing, and ships unapproved — then ' +
    'the payload is committed ahead of that branch in the log. A replay ' +
    'reaching the peek now sees the hook and wants the other fork.',
  workflow: 'hookPeekWorkflow',
  input: ['doc-8'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('step_started', 'shipWithoutApproval');
    await sim.deliverHook('peek:doc-8', { approved: true });
    await wf.release();
  },
  // What the first execution actually decided. Anything else is the bug.
  expect: {
    status: 'completed',
    output: 'shipped-unapproved:reserved:doc-8',
  },
};
