import type { ScenarioSpec } from '@workflow/world-sim';
import {
  ownerOf,
  resumeOnceAdopted,
  startHookWorld,
} from './start-hook-helpers.ts';

const token = 'order:concurrent';
const N = 5;

export const scenario: ScenarioSpec = {
  id: 'start-hook-concurrent-candidates',
  name: `start Hook: ${N} clients start one token at once`,
  description:
    'Every client is held just before its run_created, then all are let go ' +
    'together, so their admissions interleave inside the World. One is ' +
    'admitted, every other is refused naming it, and every queued copy ' +
    'replays its own decision.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const pause = sim.pauseDeliveries();
    const names = Array.from({ length: N }, (_, i) => `c${i + 1}`);
    const holds = names.map((name) =>
      sim.writer.caller(name).runToEventProduced('run_created')
    );
    const calls = names.map((caller) => sim.start({ caller, hook: { token } }));
    const held = await Promise.all(holds);
    await Promise.all(held.map((h) => h.release()));
    const outcomes = await Promise.all(calls.map((c) => c.outcome));

    const owners = new Set(outcomes.map(ownerOf));
    const owner = [...owners][0];
    sim.check(
      'everyone learns one owner',
      owners.size === 1 && owner !== undefined
    );
    sim.check(
      'exactly one client was admitted',
      outcomes.filter((o) => o.kind === 'run').length === 1
    );
    sim.check('exactly one run', sim.world.runs().length === 1);
    pause();

    const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
    sim.check(
      'the payload reaches that owner',
      delivered.kind === 'delivered' && delivered.runId === owner
    );
  },
  expect: { status: 'completed', output: 'paid' },
};
