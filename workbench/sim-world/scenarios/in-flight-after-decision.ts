import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-after-decision',
  name: 'in-flight: hook commits after the decision',
  description:
    'The receiver commits after the run has decided its branch and entered a ' +
    'wait. Both guard halves are armed but no write can be fenced before the ' +
    'hook exists. The hook takes the tail position when it lands, so the next ' +
    'delivery replays a log it can follow.',
  workflow: 'lateAppendForkWorkflow',
  input: ['doc-31'],
  preconditionGuard: true,
  countGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    const hook = await sim.beginHookDelivery('count:doc-31', {
      approved: true,
    });

    // Let the delivery play out on the branch the visible log implied, and
    // catch it inside the `wait_created` that ends it. That write is already
    // durable; nothing of this run will be checked again until the timer
    // fires.
    await wf.runToEventCommitted('wait_created');
    sim.check(
      'nothing was fenced — every write so far passed both guards',
      sim.world.rejections().length === 0
    );

    await hook.commit();
    await wf.release();
  },
  expect: {
    status: 'completed',
  },
};
