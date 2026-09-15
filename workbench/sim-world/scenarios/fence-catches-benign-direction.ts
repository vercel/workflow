import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'fence-catches-benign-direction',
  name: 'fence: the guard catches the harmless direction, not the harmful one',
  description:
    'The control that shows the fence is not merely weak here — it is aimed ' +
    'the wrong way. Same two racing steps, fence on, completions 5ms apart so ' +
    'no millisecond tie is in play. This time the withheld completion is the ' +
    'log-LATER one (`fast`), so the reader is behind the tail rather than ' +
    'holding a hole: snapshot(t=0) < marker(t=5), and the inline `step_started` ' +
    'claim for the branch step IS rejected — twice — forcing a reload that ' +
    're-decides on the full log. Exactly the self-correction one would expect ' +
    'the guard to provide. But this direction never needed it: a reader that ' +
    'sees only `slow` — the log-FIRST completion — already agrees with the ' +
    'log about who won. Flip which one is hidden (the scenario ' +
    'above) and the fence goes silent on the case that actually corrupts. The ' +
    'watermark covers the benign half of the race and misses the dangerous ' +
    'half — a hole in the middle of the log moves no high-water mark. That ' +
    'asymmetry is the whole argument for the second half of the fence, the ' +
    'count, which asks a question the mark cannot: not "how new is your ' +
    'newest?" but "how many do you hold below it?".',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-28'],
  preconditionGuard: true,
  script: async (sim) => {
    const fast = sim.writer.step('fast');
    const slow = sim.writer.step('slow');
    const atFast = fast.runToEventProduced('step_completed');
    const atSlow = slow.runToEventProduced('step_completed');
    await atFast;
    await atSlow;
    // `slow` commits visibly at t=0; the hole is armed against `fast`, which
    // commits at t=5 and is therefore the newest out-of-band write.
    await slow.release();
    sim.advanceTime(5);
    sim.withholdNextEvent(1);
    await fast.release();
  },
  // No violation: the fence fires, the run reloads and takes `afterSlow`,
  // which is what the log says. Contrast the scenario above, same fence.
  expect: { status: 'completed', output: 'afterSlow:doc-28' },
};
