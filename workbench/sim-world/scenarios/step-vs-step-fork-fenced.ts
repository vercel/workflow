import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-step-fork-fenced',
  name: 'corrupt: two racing STEPS, WITH the precondition fence on',
  description:
    "Tests the fence's predicate. WorldCapabilities.preconditionGuard is " +
    'documented as rejecting a stale write when a newer OUT-OF-BAND event ' +
    '(e.g. a received hook) was recorded. So does it fence a write made ' +
    "stale by one of the run's OWN step_completed events? Same fault as the " +
    'scenario above, fence enabled. Verified answer: NO — zero ' +
    'PreconditionFailedError rejections, and it corrupts identically. The ' +
    'reason is the shape of the predicate, not the event type: the fence ' +
    'compares the snapshot against a HIGH-WATER MARK of the newest ' +
    'out-of-band write, and rejects only `snapshot.updatedAt < marker`. Here ' +
    'the newest such write is the one the reader CAN see (`fast`); the withheld ' +
    "one is older, a hole in the middle of the log, so the reader's snapshot " +
    'is never strictly older than the mark. Separating the two completions ' +
    'in virtual time does not change it — the miss is structural, not a ' +
    'millisecond-granularity tie. Contrast the hook/wait variant above, ' +
    'where the withheld hook IS the newest out-of-band write and the ' +
    'orchestrator carries a pre-sleep snapshot: strictly older, so the same ' +
    'fence rejects twice and the run self-corrects — those rejections show ' +
    'up in the trace as `!!` lines, unasked for. ' +
    'To be precise about which fence: this scenario arms the watermark half ' +
    'ALONE, which is why `countGuard` is switched off below against the ' +
    'default. The count half is aimed at exactly this hole and does catch it. ' +
    'Neither half models world-vercel any more: a slot-identity run has no ' +
    'stale-snapshot rejection to make, because the World allocates the slot ' +
    'at commit time rather than taking a position from the writer. What the ' +
    'fence still buys is coverage of the 412 path the runtime keeps for ' +
    'Worlds that do fence. See the in-flight trio below, where the two halves ' +
    'are separated and tested one flag apart.',
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
