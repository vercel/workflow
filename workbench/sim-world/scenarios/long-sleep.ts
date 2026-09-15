import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'long-sleep',
  name: 'a thirty-day sleep costs nothing',
  workflow: 'longSleepWorkflow',
  input: ['payload'],
  expect: { status: 'completed', output: 'finalized:prepared:payload' },
};
