import type { ScenarioSpec } from '@workflow/world-sim';
import {
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
} from './lock-helpers.ts';

const KEY = 'lock-release-before-acquire:key';

export const scenario: ScenarioSpec = {
  id: 'lock-release-before-acquire',
  name: 'lock: a retry lands just after the release commits',
  description:
    "The holder's lock_released is durable but the holder has not resumed " +
    "when the waiter's retry is delivered. The slot is free, so the retry " +
    'is granted at once.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    const released = sim.park(
      {
        eventType: 'lock_released',
        phase: 'after',
        where: (c) => c.runId === sim.runId,
      },
      'holder released, not resumed'
    );
    held.release();
    const atRelease = await released;
    const waiterHolds = parkInCriticalSection(sim, () => waiter);
    const retry = sim.deliverQueued(flowMessageFor(waiter));
    const waiterParked = await waiterHolds;
    sim.check(
      'the retry was granted',
      lockEventsOf(sim, waiter).join() === 'lock_created,lock_acquired'
    );
    waiterParked.release();
    await retry;
    atRelease.release();
  },
  expect: { status: 'completed', output: 'holder:1' },
};
