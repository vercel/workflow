import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'writers-scripted-tempo',
  name: 'writers: the script names the tempo top to bottom',
  description:
    'Every ordering in this scenario is a statement: hold the orchestrator ' +
    'at the call that commits step_started, assert what the log does and does ' +
    'not contain, deliver, release, then wait for the run to finish and ' +
    'assert the committed order. `until` is the read-only counterpart to a ' +
    'hold — it waits for a point without stopping anything.',
  workflow: 'approvalWorkflow',
  input: ['doc-7'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    // Nothing else in the world can advance this writer while it is held.
    await wf.runToEventCommitted('step_started', 'reserveInventory');

    sim.check(
      'the hook is registered but nothing has been received yet',
      sim.world.events().some((e) => e.eventType === 'hook_created') &&
        !sim.world.events().some((e) => e.eventType === 'hook_received')
    );

    await sim.deliverHook('approval:doc-7', {
      approved: true,
      reviewer: 'hopper',
    });
    await wf.release();

    await sim.until({ eventType: 'run_completed', phase: 'after' });
    const order = sim.world.events().map((e) => e.eventType);
    sim.check(
      'hook_received precedes step_completed',
      order.indexOf('hook_received') < order.indexOf('step_completed')
    );
  },
  expect: {
    status: 'completed',
    output: { status: 'settled:reserved:doc-7', reviewer: 'hopper' },
  },
};
