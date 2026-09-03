import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'peek-hook-at-registration',
  name: 'peek: hook lands the instant it is registered',
  description:
    'The earliest a payload can possibly arrive. Whichever fork the first ' +
    'execution takes, the replay has to agree with it.',
  workflow: 'hookPeekWorkflow',
  input: ['doc-10'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('hook_created', { token: 'peek:doc-10' });
    await sim.deliverHook('peek:doc-10', { approved: true });
    await wf.release();
  },
  expect: { status: 'completed' },
};
