import type { ScenarioSpec } from '@workflow/world-sim';
import {
  backstopAt,
  FIFO,
  lockEventsOf,
  parkHolderCompletion,
  parkInCriticalSection,
  startWaiter,
  wakeFor,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-lost-wake:key';

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-lost-wake',
  name: 'lock (fifo): a lost handoff wake is recovered by the backstop',
  description:
    'The holder releases and reserves the slot for the waiter, but the wake ' +
    'it sends is lost. Nothing waits on the wake: the holder completes, and ' +
    'the waiter claims its reservation when its backstop fires.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  locks: FIFO,
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiter = await startWaiter(sim, KEY, 1, 'waiter');
    const backstop = backstopAt(sim, waiter) ?? 0;
    const completing = parkHolderCompletion(sim);
    held.release();
    const atCompletion = await completing;
    sim.check(
      'the release sent a wake, and it is lost',
      await sim.dropQueued(wakeFor(waiter))
    );
    atCompletion.release();
    await sim.until({ eventType: 'run_completed', runId: waiter });
    sim.check(
      'the waiter claimed at its backstop',
      sim.world.nowMs() >= backstop
    );
    sim.check(
      'with one lock_created',
      lockEventsOf(sim, waiter).join() ===
        'lock_created,lock_acquired,lock_released'
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
