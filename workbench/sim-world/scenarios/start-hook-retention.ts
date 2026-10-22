import type { ScenarioSpec } from '@workflow/world-sim';
import { startHookWorld } from './start-hook-helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const token = 'order:retention';

export const scenario: ScenarioSpec = {
  id: 'start-hook-retention',
  name: 'start Hook: the default 24h retention outlives the owner',
  description:
    'The owner ends at once. A duplicate inside the 24h default retention is ' +
    'refused naming it; one after the retention is admitted.',
  workflow: 'unadoptedOwnerWorkflow',
  input: ['first'],
  ...startHookWorld,
  script: async (sim) => {
    const ended = sim.until({ eventType: 'run_completed' }, 'the owner ends');
    const first = await sim.start({ caller: 'c1', hook: { token } }).outcome;
    const owner = first.kind === 'run' ? first.runId : '';
    await ended;

    const pause = sim.pauseDeliveries();
    sim.advanceTime(DAY - 1);
    const inside = await sim.start({ caller: 'c2', hook: { token } }).outcome;
    sim.check(
      'a duplicate inside the retention is refused naming the ended owner',
      inside.kind === 'conflict' && inside.conflictingRunId === owner
    );
    sim.advanceTime(1);
    const after = await sim.start({
      caller: 'c3',
      hook: { token },
      input: ['second'],
    }).outcome;
    sim.check('after it, a new run is admitted', after.kind === 'run');
    pause();
  },
  expect: { status: 'completed', output: 'unadopted:first' },
};
