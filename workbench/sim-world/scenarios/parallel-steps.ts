import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'parallel-steps',
  name: 'two steps suspend together',
  workflow: 'parallelStepsWorkflow',
  input: ['x'],
  expect: { status: 'completed', output: 'prepared:x|finalized:x' },
};
