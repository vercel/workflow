import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'lost-step-dispatch',
  name: 'a queued step dispatch ends without a terminal event',
  description:
    'Four steps suspend together against an inline cap of three, so the ' +
    'fourth is handed to the queue. The message is then removed without ' +
    'settling the step, which is how the sim models the end state of any ' +
    'dispatch that stopped short of a terminal event: nothing is outstanding ' +
    'for the queue to redeliver, while the idempotency claim on the key ' +
    'survives. Every later replay re-sends the dispatch and the claim absorbs ' +
    'it, so the step is created and never started and nothing else can move ' +
    'the run: the fourth Promise.all leg never settles. Recovery is the ' +
    're-dispatch watchdog. Past one watchdog interval the key carries an ' +
    'epoch the queue has not seen, and the wake armed at that boundary is ' +
    'what brings a replay back to notice. Without it the run has no ' +
    'outstanding work at all and stays running forever.',
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
