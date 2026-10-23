import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'claimed-payload-under-fork',
  name: 'the same payload, with a branch waiting for it',
  description:
    'The control for the scenario above: same movements, same tempo, same ' +
    'three deliveries in one resume, same log order — but one branch awaits ' +
    'the hook, so the payload arrives claimed. Its barrier registers armed, ' +
    'the wait no longer parks behind an entry that cannot resolve itself, ' +
    'and the step result gates on the wait the ordinary way. The same ' +
    'assertion is made here, and it holds: whatever the other scenario ' +
    'shows, it is not caused by the payload existing. As there, the timer ' +
    'overlaps the held delivery only because the script expires its lease, ' +
    'and the fence refuses that delivery’s step result.',
  workflow: 'claimedPayloadForkWorkflow',
  input: ['doc-33'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    const body = sim.writer.step('pokedWork');

    // Movement for movement the same as `unclaimed-payload-under-fork`; see
    // that file for why each hold is where it is. The single difference is
    // the workflow under it, which has a branch awaiting the hook.
    await wf.runToEventCommitted('wait_created');
    await sim.deliverHook('poke:doc-33', { kind: 'poke' });

    const atBody = body.runToEventProduced('step_completed');
    await wf.release();
    await atBody;

    sim.check('the held delivery’s lease expired', sim.expireLease() === 1);
    const atWait = wf.runToEventCommitted('wait_completed');
    const fired = sim.deliverQueued(
      (pending) =>
        pending.find((m) => m.readyAtMs > sim.world.nowMs())?.messageId
    );
    await atWait;

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

    const events = sim.world.events();
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
  expect: {
    status: 'completed',
    output: 'afterStep:doc-33|afterSleep:doc-33',
  },
};
