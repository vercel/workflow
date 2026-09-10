import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'smoke-one-step',
  name: 'smoke: a workflow with one null step',
  workflow: 'oneStepWorkflow',
  expect: { status: 'completed', output: null },
};
