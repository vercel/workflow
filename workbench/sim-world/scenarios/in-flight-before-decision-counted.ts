import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision-counted',
  name: 'in-flight: same tempo, count guard ON — the write is fenced',
  description:
    'Both halves of the fence are armed. The hook commits while the ' +
    "orchestrator is held at its decision, so it takes a slot above the caller's " +
    'watermark: the watermark half rejects the decision on its own, and the ' +
    'count at or below the watermark does not grow. The orchestrator reloads ' +
    'and decides again on a log that holds the hook.',
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

    // Matched on the decision itself, not on any 412. Which half fires is not
    // the point: with commit-time slots the hook can only land above the
    // watermark, so the watermark half is the one that can catch it. A 412
    // elsewhere would not show the decision was fenced: with the watermark
    // half disarmed, the count half lets this write through and rejects the
    // settle step's `step_completed` instead, after the branch has run.
    sim.check(
      'the fence rejected the decision',
      sim.world
        .rejections()
        .some(
          (r) =>
            r.errorName === 'PreconditionFailedError' &&
            r.writer === 'orchestrator' &&
            r.eventType === 'step_started'
        )
    );
  },
  // The rejection and the reload show up in the trace as `!!` lines. Whichever
  // branch the reload lands on, it is the one the durable log implies — so
  // there is nothing to diverge.
  expect: {
    status: 'completed',
  },
};
