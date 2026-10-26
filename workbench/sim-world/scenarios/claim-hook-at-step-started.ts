import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'claim-hook-at-step-started',
  name: 'claim: payload arrives inside the deferred step_started commit',
  description:
    'Same workflow and the same outcome, one world call later: the payload ' +
    'lands after the claim that the settled registration released, so it ' +
    'sorts between the step starting and the step completing.',
  workflow: 'claimThenApproveWorkflow',
  input: ['doc-31'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('step_started', 'reserveInventory');
    sim.check(
      'the registration the step was deferred behind is already in the log',
      sim.world.events().some((event) => event.eventType === 'hook_created')
    );
    await sim.deliverHook('claim:doc-31', {
      approved: true,
      reviewer: 'hopper',
    });
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: { status: 'settled:reserved:doc-31', reviewer: 'hopper' },
  },
};
