import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'hook-never-arrives',
  name: 'a hook that never arrives stalls instead of hanging',
  description:
    'The expected outcome is a stall: the queue drains, the run is still ' +
    'running, and the report names the hook nobody delivered.',
  workflow: 'blockedOnHookWorkflow',
  input: ['doc-4'],
  expect: { status: 'stalled' },
};
