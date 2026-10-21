import type { ScenarioSpec } from '@workflow/world-sim';
import {
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
} from './lock-helpers.ts';

const KEY = 'lock-cancelled-waiter:key';

export const scenario: ScenarioSpec = {
  id: 'lock-cancelled-waiter',
  name: 'lock: a waiter is cancelled while it waits',
  description:
    'The waiter is refused, then cancelled before its retry fires. The retry ' +
    'is delivered to a finished run and asks for nothing, so the slot the ' +
    'holder frees is never granted to a run that no longer wants it.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    await sim.cancelRun('waiter cancelled', waiter);
    held.release();
    await sim.until({ eventType: 'run_completed', runId: sim.runId });
    await sim.deliverQueued(flowMessageFor(waiter));
    sim.check(
      'the cancelled waiter was never granted',
      lockEventsOf(sim, waiter).join() === 'lock_created'
    );
    sim.check(
      'nothing is held',
      sim.world.locks().find((l) => l.key === KEY)?.count === 0
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
