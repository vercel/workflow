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
    'out-of-band write, and rejects only `stateUpdatedAt < marker`. Here the ' +
    'newest such write is the one the reader CAN see (`fast`); the withheld ' +
    "one is older, a hole in the middle of the log, so the reader's snapshot " +
    'is never strictly older than the mark. Separating the two completions ' +
    'in virtual time does not change it — the miss is structural, not a ' +
    'millisecond-granularity tie. Contrast the hook/wait variant above, ' +
    'where the withheld hook IS the newest out-of-band write and the ' +
    'orchestrator carries a pre-sleep snapshot: strictly older, so the same ' +
    'fence rejects twice and the run self-corrects — those rejections show ' +
    'up in the trace as `!!` lines, unasked for. ' +
    'To be precise about which fence: `preconditionGuard` is only the ' +
    'watermark half, which is all a client sends today. The count half ' +
    '(`countGuard`) is aimed at exactly this hole and does catch it — see the ' +
    'in-flight trio below, where the two halves are separated and tested one ' +
    'flag apart.',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-27'],
  preconditionGuard: true,
  script: async (sim) => {
    const fast = sim.writer.step('fast');
    const slow = sim.writer.step('slow');
    const atFast = fast.runToEventProduced('step_completed');
    const atSlow = slow.runToEventProduced('step_completed');
    await atFast;
    await atSlow;
    sim.withholdNextEvent(1);
    await slow.release();
    await fast.release();
  },
  // FAILS TODAY, identically to the unfenced scenario above — which is the
  // finding. Turning the watermark on changes nothing here.
  expect: { status: 'completed', output: 'afterSlow:doc-27' },
};
