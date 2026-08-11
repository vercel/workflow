import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'count-hook-before-timeout',
  name: 'count: hook lands BEFORE the timeout, branches differ by step count',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-22'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    await sim.deliverHook('count:doc-22', { approved: true });
    await wf.release();
  },
  expect: { status: 'completed' },
};
