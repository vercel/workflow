import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'race-duplicate-delivery',
  name: 'race: a webhook receiver delivers the same payload twice',
  description:
    'Two hook_received events for one hookId, straddling the step result. ' +
    'The consumer is subscribed once; the second payload has nobody to go to. ' +
    "Note the arming order: the step body's wait is armed while the " +
    'orchestrator is still held, because releasing first would let the ' +
    'completion slip past.',
  workflow: 'hookRaceStepWorkflow',
  input: ['doc-13'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    const probe = sim.writer.step('probe');

    await wf.runToEventCommitted('step_started', 'probe');
    await sim.deliverHook('race:doc-13', { approved: true });

    const completion = probe.runToEventCommitted('step_completed');
    await wf.release();
    await completion;

    await sim.deliverHook('race:doc-13', { approved: true });
    await probe.release();
  },
  expect: { status: 'completed' },
};
