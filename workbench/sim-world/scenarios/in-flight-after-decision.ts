import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-after-decision',
  name: 'in-flight: hook commits after the decision, while the run is suspended',
  description:
    'The receiver commits after the run has decided its branch and entered a ' +
    'wait, the one window in which the run makes no writes at all. The hook ' +
    'is out-of-band: it takes the log tail, moves the run’s position but not ' +
    'its in-band count, and is never refused. Nothing the orchestrator wrote ' +
    'is refused either, before or after it, since an out-of-band write cannot ' +
    'supersede an orchestrator. The next delivery replays a log that records ' +
    'the timer winning, the branch it took, and the hook arriving late, and ' +
    'finishes on that branch. This used to check that an out-of-band ' +
    'watermark and count guard had nothing to fence here; the in-band fence ' +
    'has nothing to fence for the same reason, by construction.',
  workflow: 'lateAppendForkWorkflow',
  input: ['doc-31'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    const hook = await sim.beginHookDelivery('count:doc-31', {
      approved: true,
    });

    // Let the delivery play out on the branch the visible log implied, and
    // catch it inside the `wait_created` that ends it. That write is already
    // durable; nothing of this run is written again until the timer fires.
    await wf.runToEventCommitted('wait_created');
    await hook.commit();
    const done = sim.until({ eventType: 'run_completed' });
    await wf.release();
    await done;

    sim.check(
      'nothing was refused: the hook is out-of-band and supersedes no one',
      sim.world.rejections().length === 0
    );
    const events = sim.world.events();
    const at = (type: string) => events.findIndex((e) => e.eventType === type);
    const lastWaitCreated = events
      .map((e) => e.eventType)
      .lastIndexOf('wait_created');
    sim.check(
      'the hook took the tail after the suspension’s wait_created',
      lastWaitCreated !== -1 && at('hook_received') > lastWaitCreated
    );
    sim.check(
      'the log records the timer winning ahead of the late hook',
      at('wait_completed') < at('hook_received')
    );
  },
  expect: {
    status: 'completed',
    output: 'reconciled(settled:doc-31)',
  },
};
