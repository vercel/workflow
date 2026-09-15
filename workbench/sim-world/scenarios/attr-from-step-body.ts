import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'attr-from-step-body',
  name: 'attr: a step writes run state while a hook lands mid-flight',
  description:
    'The attr_set comes from step context (writer type "step", committed ' +
    'inline, no correlationId dedupe), so unlike the orchestrator path its ' +
    'log position is decided by step timing rather than by suspension. The ' +
    'writer column in the trace names the step body that wrote it.',
  workflow: 'stepAttributeWorkflow',
  input: ['doc-16'],
  script: async (sim) => {
    const recorder = sim.writer.step('probeAndRecord');
    await recorder.runToEventCommitted('attr_set');
    await sim.deliverHook('stepattr:doc-16', { approved: true });
    await recorder.release();
  },
  expect: {
    status: 'completed',
    output: 'recorded:doc-16|probed:doc-16|yes',
  },
};
