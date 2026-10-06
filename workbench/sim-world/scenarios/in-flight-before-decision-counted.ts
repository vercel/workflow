import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision-counted',
  name: 'in-flight: same tempo, in-band fence only, so an out-of-band hook supersedes nothing',
  description:
    'The tempo of the scenario above with no precondition guard at all, ' +
    'which is what a single-orchestrator run has. The webhook receiver commits ' +
    'its hook after the orchestrator has written its timeout and while its ' +
    'branch decision (`step_started` for `settle`) is produced but not ' +
    'committed. The old count guard refused that write because an event had ' +
    'landed at or below the caller’s watermark, and the orchestrator reloaded ' +
    'and decided again. The in-band fence does not: it counts only the ' +
    'orchestrator’s own writes, and `hook_received` is out-of-band, so the ' +
    'decision is accepted as made and the hook takes the log position after ' +
    'the timeout. The log then says what the run did: the timer won the race, ' +
    '`settle` ran, and the hook was consumed late, never as the race’s winner.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-30'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    const hook = await sim.beginHookDelivery('count:doc-30', {
      approved: true,
    });
    const decision = await wf.runToEventProduced('step_started');
    sim.check(
      'the live pass decided the fork without the hook',
      JSON.stringify(decision.ctx.request?.eventData).includes('settle')
    );
    await hook.commit();
    const done = sim.until({ eventType: 'run_completed' });
    await wf.release();
    await done;

    sim.check(
      'nothing the orchestrator wrote was refused',
      sim.world.rejections().length === 0
    );
    const events = sim.world.events();
    const at = (type: string) => events.findIndex((e) => e.eventType === type);
    sim.check(
      'the log puts the timeout ahead of the hook, the order the run decided in',
      at('wait_completed') < at('hook_received')
    );
  },
  expect: {
    status: 'completed',
    output: 'reconciled(settled:doc-30)',
  },
};
