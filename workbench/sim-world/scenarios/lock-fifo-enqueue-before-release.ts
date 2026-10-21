import type { ScenarioSpec } from '@workflow/world-sim';
import {
  backstopAt,
  FIFO,
  lockEventsOf,
  parkInCriticalSection,
  startWaiter,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-enqueue-before-release:key';

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-enqueue-before-release',
  name: 'lock (fifo): an acquirer enqueues while the release is in flight',
  description:
    "The holder's lock_released is about to commit when a second run is " +
    'refused and queues. The release is decided against what it reads when ' +
    'it writes: someone is queued, so it reserves the slot for them and wakes ' +
    'them instead of freeing it.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  locks: FIFO,
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const releasing = sim.park(
      { eventType: 'lock_released', phase: 'before', runId: sim.runId },
      'release about to commit'
    );
    held.release();
    const inFlight = await releasing;
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    const backstop = backstopAt(sim, waiter) ?? 0;
    sim.check(
      'the waiter queued',
      lockEventsOf(sim, waiter).join() === 'lock_created'
    );
    inFlight.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
    sim.check(
      'the release handed the slot over and woke the waiter',
      sim.world.nowMs() < backstop
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
