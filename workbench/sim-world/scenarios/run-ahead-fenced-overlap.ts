import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'run-ahead-fenced-overlap',
  name: 'a delivery running ahead is superseded mid-pipeline',
  description:
    'Three inline steps with nothing else open, so the orchestrator runs ' +
    'ahead: loopA’s outcome reaches the workflow while its write is still ' +
    'in flight, and the delivery decides loopB from it, queueing loopB’s ' +
    'creation behind that write in its in-band writer. Hold that ' +
    'speculative step_completed before it commits, expire the lease, and let ' +
    'a second orchestrator take the run from the log: it runs loopA again ' +
    'and finishes the run. When the held write is released, the fence ' +
    'refuses it, and the writes the stalled delivery decided from its ' +
    'speculative state (loopB’s creation) never reach the World: the log ' +
    'holds one creation and one outcome per step, all from the successor ' +
    'except loopA’s creation and first start.',
  workflow: 'runAheadLoopWorkflow',
  input: ['doc-41'],
  // Bodies wait for their start: an early-started loopB body would hold the
  // process's step single flight behind the held write, and the successor,
  // in the same process, would wait on it (see step-vs-step-fork-fenced).
  // The outcome still runs ahead.
  env: { WORKFLOW_OPTIMISTIC_INLINE_START: '0' },
  script: async (sim) => {
    const first = sim.writer.step('loopA');
    await first.runToEventProduced('step_completed');

    sim.check(
      'the stalled delivery’s lease expired and its message is pending again',
      sim.expireLease({ redeliver: true }) === 1
    );
    const successorDone = sim.until({ eventType: 'run_completed' });
    const redelivered = sim.deliverQueued();
    await successorDone;
    sim.check(
      'the successor finished the run while the speculative write was held',
      sim.world.run(sim.runId)?.status === 'completed' && first.isHeld()
    );

    const refused = sim.until({ eventType: 'step_completed', failed: true });
    await first.release();
    const refusal = await refused;
    sim.check(
      'the fence refused the held speculative outcome',
      (refusal.error as { name?: string } | undefined)?.name ===
        'InBandSupersededError'
    );
    sim.check('the redelivery ran', await redelivered);

    const events = sim.world.events();
    const nameOf = (stepId: string | undefined) =>
      sim.world
        .steps()
        .find((s) => s.stepId === stepId)
        ?.stepName.split('//')
        .at(-1);
    const count = (eventType: string, name: string) =>
      events.filter(
        (e) => e.eventType === eventType && nameOf(e.correlationId) === name
      ).length;
    sim.check(
      'every step was created once and completed once',
      ['loopA', 'loopB', 'loopC'].every(
        (name) =>
          count('step_created', name) === 1 &&
          count('step_completed', name) === 1
      )
    );
    sim.check(
      'the stalled delivery wrote nothing after the refusal',
      sim.world
        .rejections()
        .filter((r) => r.errorName === 'InBandSupersededError').length === 1
    );
  },
  expect: { status: 'completed', output: 'c:b:a:doc-41' },
};
