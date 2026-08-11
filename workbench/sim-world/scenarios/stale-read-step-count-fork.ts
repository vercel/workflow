import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'stale-read-step-count-fork',
  name: 'corrupt: stale event load + step-count fork',
  description:
    'All three preconditions from PR #3147 at once. The hook is committed ' +
    'ahead of wait_completed in the log, but withheld from the read the live ' +
    'pass uses — so the live pass decides the fork without it, while the ' +
    'durable log says the hook came first. The branches differ by step count, ' +
    'so flipping the fork on replay renames every entity after it.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-23'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    // Arm the window, then write behind it: the hook takes log position 7,
    // ahead of wait_completed at 8, but the read that decides the fork does
    // not see it.
    sim.withholdNextEvent(1);
    await sim.deliverHook('count:doc-23', { approved: true });
    await wf.release();
  },
  // FAILS TODAY. The log puts the hook ahead of the timeout, so the run that
  // agrees with its own log takes the recovery branch. It takes `settle`
  // instead and then cannot replay what it wrote.
  expect: {
    status: 'completed',
    output: 'reconciled(recovered:doc-23+second)',
  },
};
