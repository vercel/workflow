import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'writers-independent-step-bodies',
  name: 'writers: two step bodies advance independently',
  description:
    'The claim the whole writer API rests on: two inline step bodies in one ' +
    "delivery are separately advanceable. Hold slow's step_completed at its " +
    "produced (pre-commit) point; while it is held, fast's step_completed " +
    'still commits. Per-writer scheduling needs no new concurrency, only a ' +
    'way to name and steer what is already there. ' +
    'Note the assertion is level-triggered (read the log) rather than ' +
    'edge-triggered (await the event): fast commits during the hold itself, ' +
    "because arming yields and fast's create was already in flight. An " +
    '`until()` here waits for an edge that has already passed and deadlocks.',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-28'],
  script: async (sim) => {
    const slow = sim.writer.step('slow');
    const held = await slow.runToEventProduced('step_completed');

    const committed = sim.world
      .events()
      .filter((e) => e.eventType === 'step_completed');
    sim.check(
      'fast committed while slow was held pre-commit',
      committed.some((e) =>
        String((e.eventData as { stepName?: string })?.stepName).endsWith(
          '//fast'
        )
      )
    );
    sim.check(
      'slow has NOT committed — it is the one being held',
      !committed.some((e) =>
        String((e.eventData as { stepName?: string })?.stepName).endsWith(
          '//slow'
        )
      )
    );

    await held.release();
  },
  expect: { status: 'completed' },
};
