'use server';

import { getFormattedStepResult } from '@/workflows/server_action_step_imports';

export type DirectImportedStepActionState = {
  error: string | null;
  result: string | null;
};

/**
 * This server action directly calls a step function that depends on imported
 * helpers. It is the smallest repro for the prod-only transform bug.
 */
export async function runDirectImportedStepAction(
  _previousState: DirectImportedStepActionState
): Promise<DirectImportedStepActionState> {
  try {
    const result = await getFormattedStepResult(41);
    return {
      error: null,
      result,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      result: null,
    };
  }
}
