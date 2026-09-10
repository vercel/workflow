import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'fork-hook-after-timeout',
  name: 'fork: hook arrives just AFTER the timeout, before the branch commits',
  description:
    'The timeout wins the race, so the first execution takes step 3 — but ' +
    'the payload is committed before that branch reaches the log. A replay ' +
    'reaching the race sees both competitors resolvable.',
  workflow: 'hookTimeoutForkWorkflow',
  input: ['doc-17'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('wait_completed');
    await sim.deliverHook('fork:doc-17', { approved: true });
    await wf.release();
  },
  // Deliberately unpinned: which branch the first execution takes is the
  // question. The replay check is the judge of whether it is reproducible.
  expect: { status: 'completed' },
};
