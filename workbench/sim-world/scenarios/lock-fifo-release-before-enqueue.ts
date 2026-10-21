import type { ScenarioSpec } from '@workflow/world-sim';
import {
  FIFO,
  flowMessageFor,
  lockEventsOf,
  parkInCriticalSection,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-release-before-enqueue:key';

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-release-before-enqueue',
  name: 'lock (fifo): the release commits while an acquirer is about to enqueue',
  description:
    "A second run's first lock_created is in flight when the holder's release " +
    'commits. The acquisition is decided against what it reads when it ' +
    'writes: the slot is free and nobody is queued, so it is granted outright ' +
    'rather than queued behind a free slot with nothing left to wake it.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  locks: FIFO,
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const acquirer = await sim.startRun('lockedWorkflow', [KEY, 1, 'acquirer']);
    const enqueue = sim.park(
      { eventType: 'lock_created', phase: 'before', runId: acquirer },
      'acquirer about to enqueue'
    );
    const delivery = sim.deliverQueued(flowMessageFor(acquirer));
    const inFlight = await enqueue;
    held.release();
    await sim.until({ eventType: 'run_completed', runId: sim.runId });
    // Granted on that very write, the acquirer runs to completion inside the
    // same delivery.
    inFlight.release();
    await delivery;
    sim.check(
      'the acquirer completed',
      sim.world.run(acquirer)?.status === 'completed'
    );
    sim.check(
      'granted outright, never queued',
      lockEventsOf(sim, acquirer).join() === 'lock_acquired,lock_released'
    );
  },
  expect: { status: 'completed', output: 'holder:1' },
};
