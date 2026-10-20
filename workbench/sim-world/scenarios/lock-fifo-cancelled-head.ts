import type { ScenarioSpec } from '@workflow/world-sim';
import {
  FIFO,
  lockEventsOf,
  parkHolderCompletion,
  parkInCriticalSection,
  startWaiter,
  wakeFor,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-cancelled-head:key';

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-cancelled-head',
  name: 'lock (fifo): the head of the queue is cancelled holding a reservation',
  description:
    'The slot is reserved for the first waiter, which is cancelled before it ' +
    "claims. The cancellation's terminal reclaim deletes its waiter row and " +
    'passes the reserved slot to the next waiter, which claims it. The ' +
    'cancelled run is never granted.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  locks: FIFO,
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const head = await startWaiter(sim, KEY, 1, 'head');
    const next = await startWaiter(sim, KEY, 1, 'next');
    const completing = parkHolderCompletion(sim);
    held.release();
    const atCompletion = await completing;
    await sim.dropQueued(wakeFor(head));
    await sim.cancelRun('head cancelled before it claimed', head);
    sim.check(
      'the reservation passed to next',
      sim.world.locks().find((l) => l.key === KEY)?.count === 1
    );
    atCompletion.release();
    await sim.until({ eventType: 'run_completed', runId: next });
    sim.check(
      'the cancelled head was never granted',
      lockEventsOf(sim, head).join() === 'lock_created'
    );
    sim.check(
      'next got the slot',
      lockEventsOf(sim, next).join() ===
        'lock_created,lock_acquired,lock_released'
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
