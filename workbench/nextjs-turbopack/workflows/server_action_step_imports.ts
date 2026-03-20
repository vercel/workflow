import {
  formatStepResult,
  incrementValue,
} from './server_action_step_import_helpers';

/**
 * This step is imported directly into a Next server action.
 * The repro breaks in production if client-mode pruning drops helper imports.
 */
export async function getFormattedStepResult(input: number): Promise<string> {
  'use step';

  const nextValue = incrementValue(input);
  return formatStepResult(nextValue);
}
