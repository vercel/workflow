import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'stale-read-step-count-fork-fenced',
  name: 'corrupt: same shape, with the optimistic-concurrency fence armed',
  description:
    'Identical to the count: fork scenario but with preconditionGuard on, so ' +
    'the World rejects a replay-context write whose snapshot predates the ' +
    'newest out-of-band event. Does the 412 fence stop it? It ' +
    'does: every rejected write is traced as a `!!` line, and the run ' +
    'reconciles instead of diverging.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-24'],
  preconditionGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    sim.withholdNextEvent(1);
    await sim.deliverHook('count:doc-24', { approved: true });
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: 'reconciled(recovered:doc-24+second)',
  },
};
