import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'fence-catches-benign-direction',
  name: 'fence: two orchestrators, the predecessor writes first',
  description:
    'The other order of the overlap above. The orchestrator stalls with its ' +
    'first `step_created` produced, its lease expires, and the redelivered ' +
    'message starts a successor, which loads the log and is held at its own ' +
    'first in-band write. The predecessor resumes first: its count is still ' +
    'current, so it is accepted, and it runs the steps, decides the fork and ' +
    'finishes the run. The successor’s write then carries the count from a ' +
    'load that predates all of that, and the fence refuses it (412 ' +
    '`in-band-superseded`). The successor stops, does not acknowledge, and its ' +
    'redelivery reloads a finished run and exits. The old scenario of this ' +
    'name showed the watermark guard catching only this, the harmless ' +
    'direction, and missing the harmful one. The in-band fence catches both ' +
    'orders the same way: whichever writer is second is refused, so each ' +
    'in-band write comes from a writer that has seen every earlier one.',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-28'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('step_created');

    sim.check(
      'the stalled delivery’s lease expired and its message is pending again',
      sim.expireLease({ redeliver: true }) === 1
    );
    const successorWrite = sim.park(
      { eventType: 'step_created', phase: 'before' },
      'successor’s first in-band write'
    );
    const redelivered = sim.deliverQueued();
    const successor = await successorWrite;

    const predecessorDone = sim.until({ eventType: 'run_completed' });
    await wf.release();
    await predecessorDone;
    sim.check(
      'the predecessor finished the run while the successor was held',
      sim.world.run(sim.runId)?.status === 'completed'
    );

    const refused = sim.until({ eventType: 'step_created', failed: true });
    successor.release();
    const refusal = await refused;
    sim.check(
      'the fence refused the successor, whose load predates the run’s end',
      (refusal.error as { name?: string } | undefined)?.name ===
        'InBandSupersededError'
    );
    sim.check('the redelivery ran', await redelivered);

    const events = sim.world.events();
    const shortName = (stepId: string | undefined) =>
      sim.world
        .steps()
        .find((s) => s.stepId === stepId)
        ?.stepName.split('//')
        .at(-1);
    const outcomes = events
      .filter((e) => e.eventType === 'step_completed')
      .map((e) => shortName(e.correlationId));
    const winner = outcomes.find((name) => name === 'fast' || name === 'slow');
    const branch = outcomes.find(
      (name) => name === 'afterFast' || name === 'afterSlow'
    );
    sim.note(`the log records ${winner} completing first, then ${branch}`);
    sim.check(
      'the run took the branch of the outcome the log records first',
      branch === (winner === 'fast' ? 'afterFast' : 'afterSlow')
    );
    sim.check(
      'every step has exactly one outcome and one start in the log',
      sim.world
        .steps()
        .every(
          (s) =>
            events.filter(
              (e) =>
                e.eventType === 'step_completed' && e.correlationId === s.stepId
            ).length === 1 &&
            events.filter(
              (e) =>
                e.eventType === 'step_started' && e.correlationId === s.stepId
            ).length === 1
        )
    );
  },
  expect: { status: 'completed' },
};
