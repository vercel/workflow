import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'stale-read-equal-step-counts',
  name: 'corrupt: stale event load with EQUAL step counts (is the amplifier needed?)',
  description:
    'Identical fault to the scenario above, but on the fork whose branches ' +
    'each emit exactly one step. If this corrupts too then step-count ' +
    'divergence raises the rate rather than being required.',
  workflow: 'hookTimeoutForkWorkflow',
  input: ['doc-25'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    sim.withholdNextEvent(1);
    await sim.deliverHook('fork:doc-25', { approved: true });
    await wf.release();
  },
  // FAILS TODAY, which answers the question in the name: the amplifier is not
  // required for corruption — it is required for the *rate* under concurrent
  // load, and for divergence deep in a long log. What corruption needs is
  // that the flipped branch claim an ordinal the log already gave to a
  // differently-named step.
  expect: { status: 'completed', output: 'step2:doc-25' },
};
