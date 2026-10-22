import type { ScenarioSpec } from '@workflow/world-sim';
import {
  fenced,
  resumeOnceAdopted,
  startHookWorld,
} from './start-hook-helpers.ts';

const token = 'order:qcf-refused';

export const scenario: ScenarioSpec = {
  id: 'start-hook-queued-copy-first-refused',
  name: "start Hook: a duplicate's queued copy is refused before its run_created",
  description:
    'An owner holds the token. A duplicate start is held between its enqueue ' +
    'and its run_created, so its queued copy reaches the World first and is ' +
    'refused: no run, no code, message acked. The direct write then replays ' +
    'the refusal, naming the same owner.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const first = await sim.start({ caller: 'owner', hook: { token } }).outcome;
    if (first.kind !== 'run')
      throw new Error(`owner not admitted: ${first.kind}`);
    const owner = first.runId;

    const dup = sim.writer.caller('dup');
    const beforeCreate = dup.runToEventProduced('run_created');
    const call = sim.start({ caller: 'dup', hook: { token } });
    const refused = sim.until(
      { eventType: 'run_started', failed: true },
      "the duplicate's queued copy is refused"
    );
    const held = await beforeCreate;
    const candidate = (held.ctx.args[0] as string) ?? '';
    await refused;
    // Its ack is checked at the end by `starthook.stranded-delivery`.
    sim.check(
      'the duplicate is not a run',
      sim.world.run(candidate) === undefined
    );

    await dup.release();
    const outcome = await call.outcome;
    sim.check(
      'the direct write is refused naming the owner',
      outcome.kind === 'conflict' && outcome.conflictingRunId === owner
    );

    const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
    sim.check(
      'the payload reaches the owner',
      delivered.kind === 'delivered' && delivered.runId === owner
    );
  },
  expect: { status: 'completed', output: 'paid' },
};

export const fencedScenario = fenced(scenario);
