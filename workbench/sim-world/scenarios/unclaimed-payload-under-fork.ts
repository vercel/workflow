import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'unclaimed-payload-under-fork',
  name: 'unclaimed hook payload sits between the fork and its wait',
  description:
    'Three deliveries are pending in one resume: a hook payload nobody ' +
    'reads, a wait_completed the log orders next, and a step result last. ' +
    'A step result is allowed to skip the unclaimed payload — it would ' +
    'otherwise stall until the barrier registry idles — but skipping the ' +
    'wait parked behind that payload inverts the order the log recorded, ' +
    'and the two branches swap the step_created ids they draw next.',
  workflow: 'unclaimedPayloadForkWorkflow',
  input: ['doc-32'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    const body = sim.writer.step('pokedWork');

    // 1. Hold the orchestrator inside the call that commits the wait, and land
    //    the payload there. Delivering it from outside that window is a race;
    //    delivering it from inside is a decision.
    await wf.runToEventCommitted('wait_created');
    await sim.deliverHook('poke:doc-32', { kind: 'poke' });

    // 2. Arm the hold on the step body *before* releasing the orchestrator.
    //    `runTo` is level-triggered and the body reaches its write during the
    //    release, so arming afterwards would be waiting for a point already
    //    gone by.
    const atBody = body.runToEventProduced('step_completed');
    await wf.release();
    await atBody;

    // 3. The step result is now outstanding and the delivery loop is stopped
    //    inside the delivery waiting on it, so the watchdog can only fire from
    //    here. Hold that second delivery the instant its `wait_completed` is
    //    durable — pick the timer explicitly, because the hook delivery
    //    enqueued a flow message of its own and it sorts earlier.
    const atWait = wf.runToEventCommitted('wait_completed');
    const fired = sim.deliverQueued(
      (pending) =>
        pending.find((m) => m.readyAtMs > sim.world.nowMs())?.messageId
    );
    await atWait;

    // 4. Land the step result immediately behind the wait, while the delivery
    //    that wrote the wait has not yet read the log back. That is what puts
    //    all three — unclaimed payload, armed wait, step result — in one
    //    barrier set, in that order. Firing the timer and releasing the step
    //    independently would give the same log with the wait's own branch
    //    already resumed, and nothing left to order.
    const atCommitted = body.runToEventCommitted('step_completed');
    await body.release();
    await atCommitted;
    await body.release();

    await wf.release();
    sim.check('the watchdog fired while the step result was held', await fired);

    // 5. The property. Two branches were resolved by two events; the log puts
    //    one of those events first. Whichever branch that is must be the
    //    branch that resumes first, because resuming is what draws the next
    //    correlation id — and a replay has nothing but log order to go on.
    //
    //    Note this is *not* the replay check. Replay runs the same code and so
    //    reproduces the same delivery order, agreeing with a log that is
    //    internally inconsistent. What breaks in production is a replay
    //    against a log some *other* build wrote, and the invariant that
    //    catches that here is the log disagreeing with itself.
    const events = sim.world.events();
    // `eventData.stepName` is the fully qualified name and only `step_created`
    // carries it, so go through the materialized step rows instead: a row's
    // `stepId` is the correlation id every event of that step shares.
    const correlationOf = (shortName: string) =>
      sim.world.steps().find((s) => s.stepName.endsWith(shortName))?.stepId;
    const at = (eventType: string, shortName: string) => {
      const correlationId = correlationOf(shortName);
      return events.findIndex(
        (e) => e.eventType === eventType && e.correlationId === correlationId
      );
    };
    const waitResolved = events.findIndex(
      (e) => e.eventType === 'wait_completed'
    );
    const stepResolved = at('step_completed', 'pokedWork');
    const sleepBranchResumed = at('step_created', 'afterPokedSleep');
    const stepBranchResumed = at('step_created', 'afterPokedStep');

    const waitWasResolvedFirst = waitResolved < stepResolved;
    const sleepBranchResumedFirst = sleepBranchResumed < stepBranchResumed;
    sim.check(
      'the branch resolved first by the log is the branch that resumes first',
      waitWasResolvedFirst === sleepBranchResumedFirst
    );
  },
  // Both branches run to completion in either delivery order, so the output is
  // the same whichever one resumes first. That is the point: nothing about the
  // result says which id each branch drew, and only the replay can tell.
  expect: {
    status: 'completed',
    output: 'afterStep:doc-32|afterSleep:doc-32',
  },
};
