import type { ScenarioSpec } from '@workflow/world-sim';
import {
  backstopFor,
  FIFO,
  lockEventsOf,
  parkHolderCompletion,
  parkInCriticalSection,
  startWaiter,
  tokenOf,
  wakeFor,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-grantee-crash:key';

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-grantee-crash',
  name: 'lock (fifo): a grantee that never claims is moved back, not dropped',
  description:
    'The slot is reserved for the first waiter, whose wake is lost and whose ' +
    'run does not come back in time. Past the grant grace, the second ' +
    "waiter's backstop retry moves the reservation to itself and claims it, " +
    'and the slow grantee goes to the tail. It is granted the slot next, ' +
    'when the second waiter releases.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  // Short enough that the first backstop retry finds the grant stale.
  locks: { ...FIFO, graceMs: 500 },
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const slow = await startWaiter(sim, KEY, 1, 'slow');
    const next = await startWaiter(sim, KEY, 1, 'next');
    const completing = parkHolderCompletion(sim);
    held.release();
    const atCompletion = await completing;
    sim.check('slow was handed the slot', await sim.dropQueued(wakeFor(slow)));
    // slow's own retry is held until next has taken the slot: it stands
    // for a grantee whose process stalled.
    const slowRetry = sim.park(
      { eventType: 'lock_created', phase: 'before', runId: slow },
      'slow grantee retries late'
    );
    const nextGranted = sim.until({ eventType: 'lock_acquired', runId: next });
    atCompletion.release();
    const first = await Promise.race([
      slowRetry.then((parked) => ({ parked })),
      nextGranted.then(() => ({ parked: undefined })),
    ]);
    if (first.parked) {
      // The loop reached slow's retry first and is held there: deliver
      // next's backstop alongside it.
      sim.check(
        "next's backstop was armed",
        await sim.deliverQueued(backstopFor(next))
      );
      await nextGranted;
      first.parked.release();
    } else {
      (await slowRetry).release();
    }
    await sim.until({ eventType: 'run_completed', runId: slow });
    sim.check(
      'next was granted before slow',
      (tokenOf(sim, next) ?? 0) < (tokenOf(sim, slow) ?? 0)
    );
    sim.check(
      'slow kept its place and got the slot',
      lockEventsOf(sim, slow).join() ===
        'lock_created,lock_acquired,lock_released'
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
