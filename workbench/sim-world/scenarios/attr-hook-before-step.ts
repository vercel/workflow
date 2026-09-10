import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'attr-hook-before-step',
  name: 'attr: hook lands BEFORE the concurrent step completes',
  description:
    'The hook-gated branch writes its attr_set ahead of the other branch ' +
    "step's result in the log.",
  workflow: 'concurrentAttributeWorkflow',
  input: ['doc-14'],
  script: async (sim) => {
    const probe = sim.writer.step('probe');
    await probe.runToEventProduced('step_completed');
    await sim.deliverHook('attr:doc-14', { approved: true });
    await probe.release();
  },
  expect: {
    status: 'completed',
    output: 'probed:doc-14/approved',
  },
};
