import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision',
  name: 'in-flight: hook commits before the decision is written — count guard off',
  description:
    'The webhook receiver begins but does not commit until the orchestrator has ' +
    'written its timeout and decided the fork without the hook. When the hook ' +
    'lands, it takes the tail position, so the log describes the same branch the ' +
    'run took. The watermark guard is intentionally the only guard enabled; the ' +
    'scenario verifies that a delayed external write does not corrupt replay.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-29'],
  preconditionGuard: true,
  // Explicit against the default, which follows the fence: this scenario is the
  // watermark half on its own, and the `-counted` twin below is the same tempo
  // with production's second half restored. One flag apart is the whole point.
  countGuard: false,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();

    // Stop the orchestrator before it submits the timeout.
    await wf.runToEventProduced('wait_completed');

    const hook = await sim.beginHookDelivery('count:doc-29', {
      approved: true,
    });
    sim.check(
      'the hook has not landed yet',
      sim.world.events().every((e) => e.eventType !== 'hook_received')
    );

    // The orchestrator decides the fork on the log it has observed. Hold it
    // before that decision is submitted. The
    // claim for a branch step is one `events.create` carrying `step_started`
    // — the `step_created` ahead of it is appended by the same write — so
    // `step_started` is the call point the decision passes through.
    const decision = await wf.runToEventProduced('step_started');
    sim.check(
      'the live pass decided the fork without the hook',
      JSON.stringify(decision.ctx.request?.eventData).includes('settle')
    );

    // The hook lands after the decision and takes the log tail.
    await hook.commit();
    await wf.release();
  },
  expect: {
    status: 'completed',
  },
};
