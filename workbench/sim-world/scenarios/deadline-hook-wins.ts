import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'deadline-hook-wins',
  name: 'hook beats its deadline',
  workflow: 'approvalWithDeadlineWorkflow',
  input: ['doc-2', '1h'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    // Hold the orchestrator the moment the deadline timer becomes durable.
    await wf.runToEventCommitted('wait_created');
    await sim.deliverHook('approval:doc-2', { approved: true });
    await wf.release();
  },
  expect: { status: 'completed', output: 'approved' },
};
