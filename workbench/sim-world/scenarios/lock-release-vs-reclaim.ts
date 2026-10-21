import type { ScenarioSpec } from '@workflow/world-sim';
import {
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
} from './lock-helpers.ts';

const KEY = 'lock-release-vs-reclaim:key';

export const scenario: ScenarioSpec = {
  id: 'lock-release-vs-reclaim',
  name: 'lock: a release races the terminal reclaim',
  description:
    'The holder is about to write its lock_released when an operator ' +
    'cancels it. The cancellation reclaims the slot; the release that ' +
    'follows is refused and frees nothing more. One waiter gets in, once: a ' +
    'double decrement would leave the key over-admitting for good, which ' +
    'the lock invariants check against the log.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    const releasing = sim.park(
      {
        eventType: 'lock_released',
        phase: 'before',
        where: (c) => c.runId === sim.runId,
      },
      'holder about to release'
    );
    held.release();
    const atRelease = await releasing;
    await sim.cancelRun('operator cancelled the holder');
    sim.check(
      'the reclaim freed the slot',
      sim.world.locks().find((l) => l.key === KEY)?.count === 0
    );
    atRelease.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
    sim.check(
      'the waiter got in once',
      lockEventsOf(sim, waiter).join() ===
        'lock_created,lock_acquired,lock_released'
    );
    sim.check(
      'nothing is held',
      sim.world.locks().find((l) => l.key === KEY)?.count === 0
    );
  },
  expect: { status: 'cancelled' },
};
