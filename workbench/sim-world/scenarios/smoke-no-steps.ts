import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'smoke-no-steps',
  name: 'smoke: a workflow with no steps at all',
  workflow: 'emptyWorkflow',
  expect: { status: 'completed', output: 'done' },
};
