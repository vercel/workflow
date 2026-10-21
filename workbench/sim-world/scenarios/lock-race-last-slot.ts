import type { ScenarioSpec } from '@workflow/world-sim';
import {
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
} from './lock-helpers.ts';

const KEY = 'lock-race-last-slot:key';

export const scenario: ScenarioSpec = {
  id: 'lock-race-last-slot',
  name: 'lock: two runs race for the last slot',
  description:
    'Concurrency 2, and the run under test holds one slot. Runs A and B both ' +
    "ask for the other: A's grant is held just before it reaches storage, B " +
    'is delivered meanwhile and takes the last slot, and A, let go, is ' +
    'refused. Exactly two holders, never three.',
  workflow: 'lockedWorkflow',
  input: [KEY, 2, 'holder'],
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const a = await sim.startRun('lockedWorkflow', [KEY, 2, 'a']);
    const b = await sim.startRun('lockedWorkflow', [KEY, 2, 'b']);

    const aAtGrant = sim.park(
      {
        eventType: 'lock_created',
        phase: 'before',
        where: (c) => c.runId === a,
      },
      'A about to ask for the last slot'
    );
    const aDelivery = sim.deliverQueued(flowMessageFor(a));
    const aParked = await aAtGrant;

    const bHolds = parkInCriticalSection(sim, () => b);
    const bDelivery = sim.deliverQueued(flowMessageFor(b));
    const bParked = await bHolds;
    sim.check(
      'B took the last slot',
      lockEventsOf(sim, b).join() === 'lock_acquired'
    );

    aParked.release();
    await aDelivery;
    sim.check('A was refused', lockEventsOf(sim, a).join() === 'lock_created');
    sim.check(
      'two holders',
      sim.world.locks().find((l) => l.key === KEY)?.count === 2
    );

    bParked.release();
    await bDelivery;
    held.release();
    await sim.until({ eventType: 'run_completed', runId: a });
  },
  expect: { status: 'completed', output: 'holder:1' },
};
