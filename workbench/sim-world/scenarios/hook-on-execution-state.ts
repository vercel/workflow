import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'hook-on-execution-state',
  name: 'hook is delivered once execution state says both steps are done',
  description:
    'The wait is on world state rather than on one named point: stop ' +
    'whichever step body commits the completion that takes the count to two, ' +
    'then deliver. The payload is buffered before the workflow ever awaits ' +
    'the hook. A `where` predicate cannot be re-checked against history, so ' +
    'this one wait is edge-triggered and leans on its own timeout.',
  workflow: 'stagedApprovalWorkflow',
  input: ['doc-6'],
  script: async (sim) => {
    const anyStep = sim.writer.anyStep();
    await anyStep.runToEventCommitted('step_completed', {
      where: (world) =>
        world.steps().filter((s) => s.status === 'completed').length === 2,
    });
    await sim.deliverHook('approval:doc-6', { approved: true });
    await anyStep.release();
  },
  expect: {
    status: 'completed',
    output: 'settled:reserved:doc-6/confirmed',
  },
};
