import type { ScenarioSpec } from '@workflow/world-sim';
import {
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
} from './lock-helpers.ts';

const KEY = 'lock-duplicate-delivery:key';

export const scenario: ScenarioSpec = {
  id: 'lock-duplicate-delivery',
  name: 'lock: a duplicate delivery re-POSTs the same scope',
  description:
    'Two deliveries of the waiter are in flight at once: the first is held ' +
    'just before its lock_created reaches storage, and a duplicate wake ' +
    'runs a second replay of the same scope to completion meanwhile. Both ' +
    'POST the same correlation id; the log gets one lock_created.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await sim.startRun('lockedWorkflow', [KEY, 1, 'waiter']);
    const firstAtCreate = sim.park(
      {
        eventType: 'lock_created',
        phase: 'before',
        where: (c) => c.runId === waiter,
      },
      'first delivery about to ask'
    );
    const first = sim.deliverQueued(flowMessageFor(waiter));
    const firstParked = await firstAtCreate;
    await sim.wakeRun(waiter);
    await sim.deliverQueued(flowMessageFor(waiter));
    firstParked.release();
    await first;
    sim.check(
      'one lock_created for the scope',
      lockEventsOf(sim, waiter).join() === 'lock_created'
    );
    held.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
  },
  expect: { status: 'completed', output: 'holder:1' },
};
