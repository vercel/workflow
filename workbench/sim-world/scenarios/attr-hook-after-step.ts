import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'attr-hook-after-step',
  name: 'attr: hook lands AFTER the concurrent step completes',
  workflow: 'concurrentAttributeWorkflow',
  input: ['doc-15'],
  script: async (sim) => {
    const probe = sim.writer.step('probe');
    await probe.runToEventCommitted('step_completed');
    await sim.deliverHook('attr:doc-15', { approved: false });
    await probe.release();
  },
  expect: {
    status: 'completed',
    output: 'probed:doc-15/rejected',
  },
};
