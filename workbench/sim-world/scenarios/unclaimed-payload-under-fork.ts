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
    'and the two branches swap the step_created ids they draw next. ' +
    'The timer fires while the step result is held only because the script ' +
    'expires the lease of the delivery holding it: the queue otherwise ' +
    'serializes a run’s orchestrator deliveries. The fence then refuses that ' +
    'stalled delivery’s step result, and the timer’s orchestrator runs the ' +
    'step again, so the resolutions it has to order all reach the log ' +
    'through one writer.',
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
    //    The queue serializes a run's orchestrator deliveries, so that
    //    timer would wait for the delivery holding the step. Expiring its
    //    lease is the overlap production reaches when a delivery stalls past
    //    its visibility timeout; the in-band fence is what keeps it safe.
    sim.check('the held delivery’s lease expired', sim.expireLease() === 1);
    const atWait = wf.runToEventCommitted('wait_completed');
    const fired = sim.deliverQueued(
      (pending) =>
        pending.find((m) => m.readyAtMs > sim.world.nowMs())?.messageId
    );
    await atWait;

    // 4. Release the held step result. Its delivery lost its lease and the
    //    timer delivery has written in-band since, so the fence refuses it:
    //    a stale writer's outcome never reaches the log. The step's outcome
    //    now comes from the current orchestrator, which runs the step again
    //    once it is released, so all three resolutions (unclaimed payload,
    //    wait, step result) are still in the log for that orchestrator to
    //    order, now in one serialized writer's order.
    const refused = sim.until({
      eventType: 'step_completed',
      stepName: 'pokedWork',
      failed: true,
    });
    await body.release();
    await refused;
    sim.check(
      'the fence refused the stalled delivery’s step result',
      sim.world
        .rejections()
        .some(
          (r) =>
            r.eventType === 'step_completed' &&
            r.errorName === 'InBandSupersededError'
        )
    );
    const finished = sim.until({ eventType: 'run_completed' });
    await wf.release();
    await finished;
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
  // result says which id each branch drew, and only the log-order check in
  // step 5 can tell. (Not the replay — as step 5 explains, replay reruns the
  // same code against the same log and agrees with it either way.)
  //
  // This scenario was red until #3406 fixed the delivery-barrier ordering; it
  // is kept as the regression test for that fix. Before single-orchestrator
  // runs the held step result itself landed behind the wait; now the fence
  // refuses it and the step's outcome comes from the current orchestrator.
  expect: {
    status: 'completed',
    output: 'afterStep:doc-32|afterSleep:doc-32',
  },
};
