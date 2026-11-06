import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-vs-step-fork',
  name: 'two racing STEPS: the outcome order is the serialized writer’s',
  description:
    'Two inline steps race, and the fork is decided by which outcome the log ' +
    'records first. On a single-orchestrator run both outcomes are in-band ' +
    'writes of the one orchestrator, and its writer submits them one at a ' +
    'time, in the order the bodies finished. So holding the first outcome ' +
    '(`fast`) at its produced point holds the second behind it: `slow` cannot ' +
    'commit first, and there is no way to make the log disagree with the order ' +
    'the run observed. The run, the log and a cold replay all take `afterFast`. ' +
    'This replaces the old shape of the scenario, which released `slow` ahead ' +
    'of a held `fast` and hid one completion from the deciding read: that ' +
    'needed two writers racing to one log, which a run now has only when a ' +
    'delivery outlives its lease (see the `-fenced` scenario below).',
  workflow: 'stepVsStepForkWorkflow',
  input: ['doc-26'],
  script: async (sim) => {
    const fast = sim.writer.step('fast');
    const slow = sim.writer.step('slow');

    await fast.runToEventProduced('step_completed');
    // Give `slow` every chance to overtake: its body has nothing to wait for.
    const overtook = sim.until(
      { eventType: 'step_completed', stepName: 'slow', phase: 'before' },
      'slow submits while fast is held'
    );
    const outcome = await Promise.race([
      overtook.then(() => 'overtook' as const),
      new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 200)),
    ]);
    sim.check(
      'slow’s outcome waits behind the held one in the orchestrator’s writer',
      outcome === 'held' &&
        !slow.history().some((p) => p.eventType === 'step_completed')
    );
    sim.check(
      'nothing is in the log while the first outcome is held',
      sim.world.events().every((e) => e.eventType !== 'step_completed')
    );

    const done = sim.until({ eventType: 'run_completed' });
    await fast.release();
    await done;

    const completions = sim.world
      .events()
      .filter((e) => e.eventType === 'step_completed')
      .map((e) => sim.world.steps().find((s) => s.stepId === e.correlationId))
      .map((s) => s?.stepName.split('//').at(-1));
    sim.check(
      'the log records fast’s outcome first, the order the writer submitted',
      completions[0] === 'fast' && completions[1] === 'slow'
    );
  },
  expect: { status: 'completed', output: 'afterFast:doc-26' },
};
