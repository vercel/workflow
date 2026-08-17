import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-step-fork-fenced',
  name: 'two racing STEPS, WITH the precondition fence on',
  description:
    "Tests the fence's predicate, and is green: a green regression test now " +
    'rather than an open reproduction. Slot-numbered event ids closed the ' +
    'fault — a read missing an event the log already holds is a gap in a ' +
    'numbered sequence, so the runtime re-reads and decides the fork the way ' +
    'the log records it, without anything having to be refused. ' +
    'What the scenario still pins is the predicate, which does NOT catch this ' +
    'shape. The watermark half compares the write against a high-water mark of ' +
    'the newest out-of-band write, and refuses only a snapshot strictly below ' +
    'it. Here the newest such write is the one the reader CAN see (`fast`); ' +
    'the withheld one is older, a hole in the middle of the log, so the ' +
    "reader's snapshot is never strictly older than the mark. Separating the " +
    'two completions in virtual time does not change it — the miss is ' +
    'structural, not a millisecond-granularity tie. Contrast the hook/wait ' +
    'variant above, where the withheld hook IS the newest out-of-band write ' +
    'and the orchestrator carries a pre-sleep snapshot. ' +
    'To be precise about which fence: this scenario arms the watermark half ' +
    'ALONE, which is why `countGuard` is switched off below against the ' +
    'default. The count half is aimed at exactly this hole and does catch it. ' +
    'Neither half models a shipped World: none of them refuses a stale write ' +
    'at all, because a reader holds a prefix rather than a hole and its next ' +
    'write comes back carrying what it was pushed past. What arming the fence ' +
    'still buys is coverage of the 412 reception path the runtime keeps for a ' +
    'World that would rather refuse than report.',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-27'],
  preconditionGuard: true,
  // The subject is the watermark predicate on its own. Production arms both
  // halves, so the count guard now follows the fence by default; a scenario
  // that exists to show what the watermark alone misses has to opt out of it.
  countGuard: false,
  script: async (sim) => {
    const fast = sim.writer.step('fast');
    const slow = sim.writer.step('slow');
    const atFast = fast.runToEventProduced('step_completed');
    const atSlow = slow.runToEventProduced('step_completed');
    await atFast;
    await atSlow;
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
  // FAILS TODAY, identically to the unfenced scenario above — which is the
  // finding. Turning the watermark on changes nothing here.
  expect: { status: 'completed', output: 'afterSlow:doc-27' },
};
