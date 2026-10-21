import type { ScenarioSpec } from '@workflow/world-sim';
import {
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
} from './lock-helpers.ts';

const KEY = 'lock-waiter-retries:key';

export const scenario: ScenarioSpec = {
  id: 'lock-waiter-retries',
  name: 'lock: a waiter retries without growing its log',
  description:
    'The run under test holds the only slot of a key, parked inside its ' +
    'critical section. A second run asks for the slot, is refused, and its ' +
    'delayed retries are delivered three times while the slot is still held. ' +
    "Each retry re-POSTs the scope's lock_created and appends nothing, so " +
    "the waiter's log holds one lock_created however long it waits. Once the " +
    'holder releases, the next retry is granted.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    sim.check(
      'the waiter waited',
      lockEventsOf(sim, waiter).join() === 'lock_created'
    );
    for (let retry = 0; retry < 3; retry++) {
      const delivered = await sim.deliverQueued(flowMessageFor(waiter));
      sim.check(`retry ${retry} was armed`, delivered);
    }
    sim.check(
      'three retries added no events',
      lockEventsOf(sim, waiter).join() === 'lock_created'
    );
    held.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
    sim.check(
      'the waiter got the slot after the release',
      lockEventsOf(sim, waiter).join() ===
        'lock_created,lock_acquired,lock_released'
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
