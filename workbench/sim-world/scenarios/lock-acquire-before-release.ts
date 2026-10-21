import type { ScenarioSpec } from '@workflow/world-sim';
import {
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
} from './lock-helpers.ts';

const KEY = 'lock-acquire-before-release:key';

export const scenario: ScenarioSpec = {
  id: 'lock-acquire-before-release',
  name: 'lock: a retry lands just before the release commits',
  description:
    "The mirror of lock-release-before-acquire: the holder's lock_released " +
    "is about to reach storage when the waiter's retry is delivered. The " +
    'slot is still held, so the retry is refused and appends nothing; the ' +
    'next one, after the release, is granted.',
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
    await sim.deliverQueued(flowMessageFor(waiter));
    sim.check(
      'the retry was refused and appended nothing',
      lockEventsOf(sim, waiter).join() === 'lock_created'
    );
    atRelease.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
  },
  expect: { status: 'completed', output: 'holder:1' },
};
