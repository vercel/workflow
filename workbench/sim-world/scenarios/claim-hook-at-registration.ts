import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'claim-hook-at-registration',
  name: 'claim: payload arrives inside the hook_created commit',
  description:
    'The awaited registration is what this run is waiting on, and the payload ' +
    'lands while the create that settles it is still being committed — so the ' +
    'whole rest of the run, the deferred step included, is written behind a ' +
    'hook_received nobody has claimed yet.',
  workflow: 'claimThenApproveWorkflow',
  input: ['doc-30'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('hook_created', { token: 'claim:doc-30' });
    await sim.deliverHook('claim:doc-30', { approved: true, reviewer: 'ada' });
    sim.check(
      'the payload is in the log before the step the registration gates',
      sim.world.events().every((event) => event.eventType !== 'step_started')
    );
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: { status: 'settled:reserved:doc-30', reviewer: 'ada' },
  },
};
