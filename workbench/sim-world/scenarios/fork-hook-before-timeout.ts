import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'fork-hook-before-timeout',
  name: 'fork: hook arrives just BEFORE the timeout commits',
  description:
    'The mirror of the case above, one world call earlier: hook_received now ' +
    'precedes wait_completed in the log, so log position should hand the race ' +
    'to the hook and fork the other way.',
  workflow: 'hookTimeoutForkWorkflow',
  input: ['doc-20'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    await sim.deliverHook('fork:doc-20', { approved: true });
    await wf.release();
  },
  expect: { status: 'completed' },
};
