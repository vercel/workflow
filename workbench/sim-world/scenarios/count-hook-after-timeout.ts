import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'count-hook-after-timeout',
  name: 'count: hook lands AFTER the timeout, branches differ by step count',
  description:
    'The shape PR #3147 identified as the amplifier: settle emits one step, ' +
    'recovery emits two, so flipping the branch on replay renames every ' +
    'correlation ID after the fork.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-21'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('wait_completed');
    await sim.deliverHook('count:doc-21', { approved: true });
    await wf.release();
  },
  expect: { status: 'completed' },
};
