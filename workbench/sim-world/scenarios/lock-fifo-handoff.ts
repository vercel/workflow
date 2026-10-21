import type { ScenarioSpec } from '@workflow/world-sim';
import {
  backstopAt,
  FIFO,
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
  wakeFor,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-handoff:key';

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-handoff',
  name: 'lock (fifo): a release hands the slot to the queued waiter and wakes it',
  description:
    'On a FIFO World a refused acquisition queues and arms only its slow ' +
    "backstop. The holder's lock_released reserves the slot for the waiter " +
    'and the runtime sends it one wake; the waiter claims on that wake, ' +
    'long before its backstop would fire.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  locks: FIFO,
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    const backstop = backstopAt(sim, waiter);
    sim.check('the waiter armed a backstop', backstop !== undefined);
    sim.check(
      'and nothing else',
      wakeFor(waiter)(sim.world.pendingMessages()) === undefined
    );
    held.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
    sim.check(
      'the waiter claimed before its backstop',
      sim.world.nowMs() < (backstop ?? 0)
    );
    sim.check(
      'one lock_created, then the claim',
      lockEventsOf(sim, waiter).join() ===
        'lock_created,lock_acquired,lock_released'
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
