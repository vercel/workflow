import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-step-fork-fenced',
  name: 'two racing STEPS, two orchestrators: the successor writes first',
  description:
    'The overlap the queue cannot rule out. The orchestrator stalls with its ' +
    'first `step_created` produced but not committed, its lease expires, and ' +
    'the queue redelivers the same message to a second orchestrator alongside ' +
    'it. The successor loads a log with no steps in it, creates and runs both ' +
    'steps inline itself, decides the fork and finishes the run. When the ' +
    'stalled predecessor resumes, its write carries the in-band count it ' +
    'loaded, which the successor has moved past, so the in-band fence refuses ' +
    'it (412 `in-band-superseded`, never a 409 for the step the successor ' +
    'created): the predecessor stops before it runs a step body, and does not ' +
    'acknowledge its message. Every step in the log has one start and one ' +
    'outcome, all the successor’s, and the branch the run took is the one the ' +
    'log records. (The stall is placed before the steps start because two ' +
    'deliveries in one process share the runtime’s per-process step single ' +
    'flight: a successor would wait for a stalled inline body rather than run ' +
    'it.) This used to be the shape the watermark guard could not see (two ' +
    'writers deciding one fork from different views); the fence needs no view ' +
    'of the log at all. `fence-catches-benign-direction` below is the other ' +
    'order: the predecessor writes first.',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-27'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('step_created');

    sim.check(
      'the stalled delivery’s lease expired and its message is pending again',
      sim.expireLease({ redeliver: true }) === 1
    );
    const successorDone = sim.until({ eventType: 'run_completed' });
    const redelivered = sim.deliverQueued();
    await successorDone;
    sim.check(
      'the successor finished the run while the predecessor was stalled',
      sim.world.run(sim.runId)?.status === 'completed' && wf.isHeld()
    );

    const refused = sim.until({ eventType: 'step_created', failed: true });
    await wf.release();
    const refusal = await refused;
    sim.check(
      'the fence refused the stalled predecessor’s write',
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
