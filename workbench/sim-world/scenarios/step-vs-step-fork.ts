import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-step-fork',
  name: 'two racing STEPS, no hook anywhere',
  description:
    'Green since slot-numbered event ids: a read missing an event the log already holds is a gap in a numbered sequence, so the runtime re-reads and decides the fork the way the log records it. Kept as the regression test for that. Answers "does this need an out-of-band event type?" — no. The fork is ' +
    "decided by two of the run's own step_completed events, and withholding " +
    'one of them from the deciding read is enough. Two inline step bodies in ' +
    'ONE invocation are already two concurrent writers to the same log; no ' +
    'second invocation is required. ' +
    'Both writers are held so the ordering is stated rather than observed: ' +
    'stop `fast` and `slow` at their produced points, arm the withhold, then ' +
    "release `slow` first, so the log's earliest completion is the one hidden " +
    'from the read that decides the fork. Hiding the *later* completion ' +
    'instead is harmless — the live pass then agrees with the log by ' +
    'accident — which is why the choice has to be made on purpose. ' +
    'Note that both waits are started before either is awaited: awaiting the ' +
    'first would let the second writer sail past its point.',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-26'],
  script: async (sim) => {
    const fast = sim.writer.step('fast');
    const slow = sim.writer.step('slow');

    const atFast = fast.runToEventProduced('step_completed');
    const atSlow = slow.runToEventProduced('step_completed');
    await atFast;
    await atSlow;

    sim.check(
      'neither completion is in the log while both writers are held',
      sim.world.events().filter((e) => e.eventType === 'step_completed')
        .length === 0
    );

    // Who this withheld reader is in production: not this invocation. With
    // strongly-consistent reads a single invocation cannot miss its own
    // committed write, so the reader that misses one of these two step
    // writes is a *concurrent second invocation* of the same run — the storm
    // shape, which the sim cannot model directly (DESIGN §10). The withhold
    // stands in for that reader; it is not a claim that a single-invocation
    // read can be stale.
    sim.withholdNextEvent(1);
    await slow.release();
    await fast.release();
  },
  // FAILS TODAY. `slow` commits first, so the log says `slow` won the race
  // and the run should end on `afterSlow`. The live pass sees only `fast`.
  expect: { status: 'completed', output: 'afterSlow:doc-26' },
};
