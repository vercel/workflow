import type { ScenarioSpec } from '@workflow/world-sim';

const LOSER_DELAY_MS = 60_000;

export const scenario: ScenarioSpec = {
  id: 'clock-after-race',
  name: 'Date.now() after Promise.race depends on replay timing',
  description:
    'A step races an out-of-band hook. The live pass receives only the step, ' +
    'reads Date.now(), chooses the before-cutoff branch, and is held while ' +
    'writing that branch’s wait_created. The hook then commits one minute ' +
    'later, ahead of the held wait — event positions are assigned at commit, ' +
    'so the hook lands ahead of the still-held wait. That payload forces ' +
    'a new pass over the extended log. In the new pass both the step ' +
    'completion and hook payload are already in the log, and ' +
    'EventsConsumer consumes them synchronously before either promise ' +
    'continuation runs. Delivery barriers preserve the step as the ' +
    'Promise.race winner, but the VM clock has already advanced to the hook’s ' +
    'later createdAt. The new pass chooses the after-cutoff branch and the ' +
    'final log records only that later answer, even though the first pass ' +
    'already selected the before-cutoff wait. This uses ' +
    'complete, strongly-consistent reads: no ' +
    'stale read, precondition fence, or missing event is involved.',
  workflow: 'clockAfterRaceWorkflow',
  input: ['clock-probe'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    const fast = sim.writer.step('fast');

    // Hold the step completion, then arm a hold for the wait the live pass
    // creates after reading the clock. The hold must exist before the winner
    // is released or the write can pass before the script observes it.
    await fast.runToEventProduced('step_completed');
    const atWait = wf.runToEventProduced('wait_created');
    await fast.release();
    const heldWait = await atWait;

    const requestedResumeAt =
      heldWait.ctx.request?.eventType === 'wait_created'
        ? new Date(heldWait.ctx.request.eventData.resumeAt).getTime()
        : undefined;
    sim.check(
      'the first pass read the early clock and selected the two-minute wait',
      requestedResumeAt === sim.world.nowMs() + 2 * 60_000
    );

    // The live workflow has already read Date.now() and selected its branch.
    // Move time across the cutoff and commit the losing hook while that branch
    // event is held. Commit-time positions put the hook before the wait.
    sim.advanceTime(LOSER_DELAY_MS);
    await sim.deliverHook('clock:clock-probe', { fired: true });

    sim.check(
      'the later hook committed while the before-cutoff wait was still held',
      sim.world.events().some((event) => event.eventType === 'hook_received') &&
        !sim.world.events().some((event) => event.eventType === 'wait_created')
    );

    await wf.release();
    await sim.until({ eventType: 'run_completed', phase: 'after' });

    const branchStepNames = sim.world
      .events()
      .flatMap((event) =>
        event.eventType === 'step_created' &&
        (event.eventData.stepName === 'afterClockBeforeCutoff' ||
          event.eventData.stepName === 'afterClockAfterCutoff')
          ? [event.eventData.stepName]
          : []
      );
    sim.check(
      'every pass selected the same Date.now() branch',
      branchStepNames.length === 1 &&
        branchStepNames[0] === 'afterClockBeforeCutoff'
    );
  },
  // The run completes and its final log cold-replays cleanly. The scenario is
  // red because the first pass selected the before-cutoff branch (proved by its
  // two-minute wait), while a later pass over the extended log selected the
  // after-cutoff step. The log records only the later answer.
  expect: {
    status: 'completed',
  },
};
