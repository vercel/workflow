import type { ScenarioSpec } from '@workflow/world-sim';
import { resumeOnceAdopted, startHookWorld } from './start-hook-helpers.ts';

const token = 'order:turbo';

export const scenario: ScenarioSpec = {
  id: 'start-hook-refused-under-turbo',
  name: "start Hook: a refused candidate's first delivery under turbo runs no step body",
  description:
    "The owner's workflow starts with a step, which turbo would run inline " +
    'before run_started on a first delivery. A duplicate is held before its ' +
    'run_created so its queued copy, attempt 1 with turbo on, is the write ' +
    'that decides it. It is refused, and no user code ran for it.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const turbo = process.env.WORKFLOW_TURBO;
    sim.check(
      'turbo is on',
      turbo === undefined || turbo === '' || !/^(0|false)$/i.test(turbo)
    );
    const first = await sim.start({ caller: 'owner', hook: { token } }).outcome;
    const owner = first.kind === 'run' ? first.runId : '';

    const dup = sim.writer.caller('dup');
    const beforeCreate = dup.runToEventProduced('run_created');
    const call = sim.start({ caller: 'dup', hook: { token } });
    const decided = sim.until(
      { eventType: 'run_started', failed: true },
      "the duplicate's first delivery is refused"
    );
    const candidate = (await beforeCreate).ctx.args[0] as string;
    await decided;
    sim.check(
      'no step body ran for the duplicate',
      !sim.effects().some((e) => e.runId === candidate)
    );
    sim.check(
      'the owner did run its first step',
      sim.effects().some((e) => e.runId === owner && e.label === 'owner:begin')
    );
    await dup.release();
    const outcome = await call.outcome;
    sim.check(
      'the duplicate learns the owner',
      outcome.kind === 'conflict' && outcome.conflictingRunId === owner
    );
    await resumeOnceAdopted(sim, token, { note: 'paid' });
  },
  expect: { status: 'completed', output: 'paid' },
};
