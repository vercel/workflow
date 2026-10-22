import type { ScenarioSpec } from '@workflow/world-sim';
import {
  fenced,
  resumeOnceAdopted,
  startHookWorld,
} from './start-hook-helpers.ts';

const token = 'order:qcf-admits';

export const scenario: ScenarioSpec = {
  id: 'start-hook-queued-copy-first-admits',
  name: "start Hook: the queued copy admits the candidate before start()'s run_created",
  description:
    'start() publishes first, then writes run_created. The caller is held ' +
    'between the two, so the queued copy reaches the World first, admits the ' +
    'candidate with a resilient run_started and runs it. The direct write then ' +
    'replays that decision and returns the same run.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const caller = sim.writer.caller('c1');
    const beforeCreate = caller.runToEventProduced('run_created');
    const call = sim.start({ caller: 'c1', hook: { token } });
    const admitted = sim.until(
      { eventType: 'run_started', failed: false },
      'queued copy admits'
    );
    await beforeCreate;
    await admitted;
    sim.check(
      'the queued copy created the run before run_created was sent',
      sim.world.runs().length === 1
    );

    await caller.release();
    const outcome = await call.outcome;
    sim.check(
      "start() returns the queued copy's run",
      outcome.kind === 'run' && outcome.runId === sim.runId
    );
    sim.check(
      'one run_created in the log',
      sim.world.events(sim.runId).filter((e) => e.eventType === 'run_created')
        .length === 1
    );

    const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
    sim.check('the payload reaches the owner', delivered.kind === 'delivered');
  },
  expect: { status: 'completed', output: 'paid' },
};

export const fencedScenario = fenced(scenario);
