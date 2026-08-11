import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'deadline-expires',
  name: 'deadline expires with no hook',
  description:
    'Nothing delivers the hook, so the run finishes on the timer. One hour ' +
    'of virtual time, no wall-clock wait.',
  workflow: 'approvalWithDeadlineWorkflow',
  input: ['doc-3', '1h'],
  expect: { status: 'completed', output: 'timed-out' },
};
