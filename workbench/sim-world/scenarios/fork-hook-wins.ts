import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'fork-hook-wins',
  name: 'fork: hook arrives before the timeout',
  workflow: 'hookTimeoutForkWorkflow',
  input: ['doc-18'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('wait_created');
    await sim.deliverHook('fork:doc-18', { approved: true });
    await wf.release();
  },
  expect: { status: 'completed', output: 'step2:doc-18' },
};
