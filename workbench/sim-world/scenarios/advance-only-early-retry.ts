import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'advance-only-early-retry',
  name: 'a retrying branch advances while its inline sibling is held',
  description:
    'Hold the slow sibling before commit, deliver the delayed retry from a ' +
    'second invocation, and observe its chained step before releasing slow.',
  workflow: 'advanceOnlyEarlyRetryWorkflow',
  input: ['early-retry'],
  script: async (sim) => {
    const slow = sim.writer.step('handoffSlowFirst');
    const slowHeld = await slow.runToEventProduced('step_completed');
    const retryQueued = sim.until({
      call: 'queue',
      where: (ctx) =>
        (ctx.message as { stepId?: string } | undefined)?.stepId !== undefined,
    });
    await retryQueued;
    const retryReadyAt = sim.world
      .pendingMessages()
      .find((message) => message.stepId !== undefined)?.readyAtMs;
    sim.check('the delayed retry message exists', retryReadyAt !== undefined);

    const secondAttempt = sim.writer
      .orchestrator()
      .runToEventCommitted('step_started', {
        stepName: 'advanceOnlyRetryOnce',
        where: (world) =>
          world
            .events()
            .filter(
              (event) =>
                event.eventType === 'step_started' &&
                String(
                  (event.eventData as { stepName?: string } | undefined)
                    ?.stepName
                ).endsWith('//advanceOnlyRetryOnce')
            ).length === 2,
      });
    const delivered = sim.deliverQueued(
      (pending) => pending.find((message) => message.stepId)?.messageId
    );
    const retryHeld = await secondAttempt;
    sim.check(
      'the retry started only after its delayed message became ready',
      retryReadyAt !== undefined && sim.world.nowMs() >= retryReadyAt
    );
    sim.check(
      'slow is still outside the log when the retry starts',
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
    await retryHeld.release();
    sim.check('the delayed retry message was delivered', await delivered);
    await slowHeld.release();
  },
  expect: {
    status: 'completed',
    output: ['next:early-retry', 'slow-1:early-retry'],
  },
};
