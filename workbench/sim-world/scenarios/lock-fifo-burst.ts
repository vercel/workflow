import type { ScenarioSpec } from '@workflow/world-sim';
import {
  FIFO,
  parkInCriticalSection,
  startWaiter,
  tokenOf,
} from './lock-helpers.ts';

const KEY = 'lock-fifo-burst:key';
const WAITERS = 5;

export const scenario: ScenarioSpec = {
  id: 'lock-fifo-burst',
  name: 'lock (fifo): a burst of waiters behind concurrency 1 runs in order',
  description:
    `${WAITERS} runs queue behind the holder of a concurrency-1 key. Each ` +
    'release hands the slot to the next in line and wakes it, so they run ' +
    'one at a time, in the order they queued, on handoff wakes alone. The ' +
    'log-derived FIFO invariant checks the same order independently.',
  workflow: 'lockedWorkflow',
  input: [KEY, 1, 'holder'],
  locks: FIFO,
  script: async (sim) => {
    const held = await parkInCriticalSection(sim, () => sim.runId);
    const waiters: string[] = [];
    for (let i = 0; i < WAITERS; i++) {
      waiters.push(await startWaiter(sim, KEY, 1, `w${i}`));
    }
    const startedAt = sim.world.nowMs();
    held.release();
    for (const waiter of waiters) {
      await sim.until({ eventType: 'run_completed', runId: waiter });
    }
    const tokens = waiters.map((w) => tokenOf(sim, w) ?? 0);
    sim.check(
      'granted in queue order',
      tokens.every((t, i) => i === 0 || t > tokens[i - 1])
    );
    sim.check('without waiting on a backstop', sim.world.nowMs() === startedAt);
  },
  expect: { status: 'completed', output: 'holder:1' },
};
