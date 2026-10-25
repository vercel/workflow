import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-timer-early-settlement',
  name: 'timer settles the race while the losing step stays held',
  description:
    'Hold the step result before it enters the log, deliver the one-hour timer ' +
    'from a second queue message, and assert that the terminal guard keeps the ' +
    'run open until the losing step is released.',
  workflow: 'stepVsTimerEarlySettlementWorkflow',
  input: ['doc-33'],
  script: async (sim) => {
    const step = sim.writer.step('heldRaceStep');
    await step.runToEventProduced('step_completed');

    const fired = await sim.deliverQueued(
      (pending) =>
        pending.find((message) => message.readyAtMs > sim.world.nowMs())
          ?.messageId
    );
    sim.check('the timer continuation was delivered', fired);
    sim.check(
      'the run stayed open while the losing step was still held',
      sim.world.run(sim.runId)?.status === 'running' && step.isHeld()
    );

    await step.release();
  },
  expect: { status: 'completed', output: 'timer:doc-33' },
};
