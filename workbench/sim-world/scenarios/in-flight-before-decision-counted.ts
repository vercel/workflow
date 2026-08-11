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
    'tempo, one flag apart. Note it is dark in production, because no client ' +
    'sends the count today. ' +
    'Under an append-only log the 412 still fires and now saves nothing: the ' +
    'count is taken at or below the caller’s watermark, and the watermark ' +
    'is a millisecond, so a hook that commits after the timeout inside the ' +
    'same virtual millisecond still counts as "at or below" it. The reload ' +
    'sees the hook behind the timeout in log order, re-decides the same way, ' +
    'and settles — a restart with nothing to correct. That is what the ' +
    'fence costs once the log is append-only: false positives at millisecond ' +
    'granularity, in exchange for a hole that can no longer open.',
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

    // The point of the scenario, and the part that is true in both worlds: the
    // count half of the fence fires where the watermark half did not. What the
    // reload then decides is a different question and belongs to the world —
    // mint-ordered it corrects the branch, append-only it re-confirms it — so
    // that half is left to the trace. Asserting it here is what forced this
    // scenario to carry two expectations, and it was never what distinguished
    // it from its uncounted twin.
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
