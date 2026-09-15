import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'fork-timeout-wins',
  name: 'fork: hook never arrives, timeout decides',
  workflow: 'hookTimeoutForkWorkflow',
  input: ['doc-19'],
  expect: { status: 'completed', output: 'step3:doc-19' },
};
