import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision-counted',
  name: 'in-flight: same tempo, count guard ON — the write is fenced',
  description:
    'Identical to the scenario above with the count half of the fence armed: ' +
    'the caller sends how many events it had loaded at or below its own ' +
    'watermark, and the world compares that against how many the log actually ' +
    'holds there. The hook committed in the meantime, so the log holds one ' +
    'more than the caller loaded and C is rejected with a 412 — even though ' +
    'the watermark comparison passes. The orchestrator reloads, sees the hook ' +
    'ahead of the timeout in log order, re-decides the fork as "arrived", and ' +
    'commits the branch the log agrees with. This is the regression test for ' +
    'the half of the fence a high-water mark cannot express: same fault, same ' +
    'tempo, one flag apart. The count the caller sends is the same number ' +
    '`@workflow/core` puts on every replay-context create; what differs is ' +
    'what a World does with it. This sim rejects on it, which is why the flag ' +
    'below is the default and the twin above has to switch it off. ' +
    'Which half fires is no longer the point, though, and that is what slot ' +
    'positions changed. A watermark used to be a millisecond, so two writes ' +
    'inside one virtual millisecond compared equal and only the count could ' +
    'separate them; a watermark that is a slot is strictly ordered, so the ' +
    'watermark half now rejects this on its own. What the scenario still ' +
    'asserts is that the fence fires at all. ' +
    'Under an append-only log the 412 still fires and saves nothing: the ' +
    'reload sees the hook behind the timeout in log order, re-decides the ' +
    'same way, and settles — a restart with nothing to correct. ' +
    'Mint-ordered there is no fence to reach: the receiver holds a position ' +
    'ahead of everything the orchestrator writes, so the log has a hole in it ' +
    'while the write is in flight, and the next replay refuses the log ' +
    'outright rather than following it into the wrong branch.',
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

    // Matched on the error, not on "something was rejected". The twin rejects
    // too — its writes hit `RunExpiredError` once the corrupted branch has run
    // — so a bare `rejections().length > 0` would hold there as well and
    // assert nothing about the fence.
    //
    // Only asserted under an append-only log, because only there does the
    // write reach the fence. Mint-ordered, the receiver's reserved position is
    // binding, so the log carries a hole for as long as the write is in
    // flight, and the replay that reads it refuses the log before any write of
    // its own is checked. That refusal is the violation the trace reports; a
    // check here would restate it as a second failure.
    if (sim.appendOnlyLog) {
      sim.check(
        'the fence rejected the write',
        sim.world
          .rejections()
          .some((r) => r.errorName === 'PreconditionFailedError')
      );
    }
  },
  // The rejection and the reload show up in the trace as `!!` lines. Whichever
  // branch the reload lands on, it is the one the durable log implies — so
  // there is nothing to diverge, in either world.
  expect: {
    status: 'completed',
  },
};
