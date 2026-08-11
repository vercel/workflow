import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'lost-step-dispatch',
  name: 'a queued step dispatch is accepted and lost',
  description:
    'Four steps suspend together against an inline cap of three, so the ' +
    'fourth is handed to the queue. The queue takes the message, keeps its ' +
    'idempotency key, and never delivers it. Every later replay re-sends the ' +
    'dispatch and the queue absorbs it as a duplicate, so the step is created ' +
    'and never started and nothing else can move the run: the fourth ' +
    'Promise.all leg never settles. Recovery is the re-dispatch watchdog — ' +
    'past one watchdog interval the key carries an epoch the queue has not ' +
    'seen, and the wake armed at that boundary is what brings a replay back ' +
    'to notice. Without it the run has no outstanding work at all and stays ' +
    'running forever.',
  workflow: 'fanOutStepsWorkflow',
  input: ['x'],
  script: async (sim) => {
    // Hold an inline body pre-commit so the invocation is parked at a point
    // where the overflow step's dispatch is already enqueued.
    const held = await sim.writer
      .step('fanA')
      .runToEventProduced('step_completed');
    const dropped = sim.dropQueued(
      (pending) => pending.find((m) => m.stepId !== undefined)?.messageId
    );
    sim.check('a step dispatch was queued and dropped', dropped);
    await held.release();
  },
  expect: { status: 'completed', output: 'a:x|b:x|c:x|d:x' },
};
