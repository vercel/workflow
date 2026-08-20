import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision-counted',
  name: 'in-flight: same tempo, count guard ON — the write is fenced',
  description:
    'The count half of the fence is armed. A hook committed while the writer was ' +
    'held can make the count at the caller watermark grow, so the write is ' +
    'rejected and the orchestrator reloads before deciding again.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-30'],
  preconditionGuard: true,
  countGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    const hook = await sim.beginHookDelivery('count:doc-30', {
      approved: true,
    });
    await wf.runToEventProduced('step_started');
    await hook.commit();
    await wf.release();

    // Matched on the count half's own message, not on "something was
    // rejected". The twin rejects too — its writes hit `RunExpiredError` once
    // the corrupted branch has run — so a bare `rejections().length > 0` would
    // hold there as well and assert nothing about the guard.
    sim.check(
      'the count guard fenced the write the watermark let through',
      sim.world
        .rejections()
        .some((r) => r.message.includes('at or below the caller'))
    );
  },
  // The rejection and the reload show up in the trace as `!!` lines. Whichever
  // branch the reload lands on, it is the one the durable log implies — so
  // there is nothing to diverge, in either world.
  expect: {
    status: 'completed',
  },
};
