import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'advance-only-handoff',
  name: 'a settled inline branch hands off its continuation',
  description:
    "Slow's result is held before commit while fast finishes. The original " +
    'delivery queues an advance-only hand-off, and delivering it starts the ' +
    'next fast step without releasing slow.',
  workflow: 'advanceOnlyHandoffWorkflow',
  input: ['handoff'],
  script: async (sim) => {
    const slow = sim.writer.step('handoffSlowFirst');
    const slowHeld = await slow.runToEventProduced('step_completed');
    const nextFast = sim.writer
      .orchestrator()
      .runToEventCommitted('step_started', 'handoffFastSecond');
    const handoffQueued = sim.until({
      call: 'queue',
      where: (ctx) =>
        (ctx.message as { advanceOnly?: boolean } | undefined)?.advanceOnly ===
        true,
    });

    // The simulator virtualizes timers, including the hand-off's 10 ms
    // coalescing window. A held writer freezes automatic virtual-time
    // advancement, so cross that named window explicitly.
    sim.advanceTime(20);
    await handoffQueued;
    const delivered = sim.deliverQueued(
      (pending) =>
        pending.find((message) => message.stepId === undefined)?.messageId
    );
    const fastHeld = await nextFast;
    sim.check(
      'the slow result is still outside the log when fast advances',
      !sim.world
        .events()
        .some(
          (event) =>
            event.eventType === 'step_completed' &&
            String(
              (event.eventData as { stepName?: string } | undefined)?.stepName
            ).endsWith('//handoffSlowFirst')
        )
    );
    await fastHeld.release();
    sim.check('the hand-off queue message was delivered', await delivered);
    await slowHeld.release();
  },
  expect: {
    status: 'completed',
    output: ['fast-2:handoff', 'slow-2:handoff'],
  },
};
