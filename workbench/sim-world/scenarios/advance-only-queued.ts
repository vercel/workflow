import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'advance-only-queued',
  name: 'a queued branch replays while its inline sibling is held',
  description:
    'With one inline slot, slow remains in the original delivery and fast is ' +
    "queued. Fast's handler settles and starts its next step without taking " +
    'ownership of slow.',
  workflow: 'advanceOnlyQueuedWorkflow',
  input: ['queued'],
  script: async (sim) => {
    const originalMaxInline = process.env.WORKFLOW_MAX_INLINE_STEPS;
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    try {
      const slow = sim.writer.step('handoffSlowFirst');
      const slowHeld = await slow.runToEventProduced('step_completed');
      const nextFast = sim.writer
        .orchestrator()
        .runToEventCommitted('step_started', 'handoffFastSecond');
      const delivered = sim.deliverQueued(
        (pending) =>
          pending.find(
            (message) =>
              message.stepId !== undefined &&
              message.readyAtMs === sim.world.nowMs()
          )?.messageId
      );

      const fastHeld = await nextFast;
      sim.check(
        'the inline slow result is still held when the queued branch advances',
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
      sim.check('the queued fast step was delivered', await delivered);
      await slowHeld.release();
    } finally {
      if (originalMaxInline === undefined) {
        delete process.env.WORKFLOW_MAX_INLINE_STEPS;
      } else {
        process.env.WORKFLOW_MAX_INLINE_STEPS = originalMaxInline;
      }
    }
  },
  expect: {
    status: 'completed',
    output: ['slow-2:queued', 'fast-2:queued'],
  },
};
