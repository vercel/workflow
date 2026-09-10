import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'step-retries-twice',
  name: 'a step retries twice and then succeeds',
  workflow: 'retryingWorkflow',
  input: ['charge'],
  expect: { status: 'completed', output: 'charge:ok-on-attempt-3' },
};
