import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-timer-early-settlement',
  name: 'timer settles the race while the losing step stays held',
  description:
    'Hold the step result before it enters the log, expire the lease of the ' +
    'delivery running it, deliver the one-hour timer from a second queue ' +
    'message, and assert that the run completes before the losing step is ' +
    'released. Without the lease expiry the timer would wait for the held ' +
    'delivery: the queue serializes a run’s orchestrator deliveries. With it, ' +
    'the two overlap, and the in-band fence refuses the stalled delivery’s ' +
    'late step_completed, so the log keeps the timer’s answer.',
  workflow: 'stepVsTimerEarlySettlementWorkflow',
  input: ['doc-33'],
  script: async (sim) => {
    const step = sim.writer.step('heldRaceStep');
    await step.runToEventProduced('step_completed');

    // The step runs inline in the run's only orchestrator delivery, so the
    // timer can fire alongside it only once that delivery's lease is gone.
    sim.check('the held delivery’s lease expired', sim.expireLease() === 1);
    const fired = await sim.deliverQueued(
      (pending) =>
        pending.find((message) => message.readyAtMs > sim.world.nowMs())
          ?.messageId
    );
    sim.check('the timer continuation was delivered', fired);
    sim.check(
      'the run completed while the losing step was still held',
      sim.world.run(sim.runId)?.status === 'completed' && step.isHeld()
    );

    await step.release();
    sim.check(
      'the fence refused the stalled delivery’s late step result',
      sim.world
        .rejections()
        .some(
          (r) =>
            r.eventType === 'step_completed' &&
            r.errorName === 'InBandSupersededError'
        )
    );
  },
  expect: { status: 'completed', output: 'timer:doc-33' },
};
