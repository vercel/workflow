// ============================================================
// HELPER FUNCTIONS FOR ERROR TESTING
// ============================================================
// These helpers are imported by 99_e2e.ts to test cross-file error propagation.
// They verify that stack traces correctly reference this file (helpers.ts).

// --- Workflow Error Helpers (called directly in workflow code) ---

function throwError() {
  throw new Error('Error from imported helper module');
}

/** Called by errorWorkflowCrossFile - creates a call chain across files */
export function callThrower() {
  throwError();
}

// --- Step Error Helpers (step function that throws from this file) ---

function throwErrorFromStep() {
  throw new Error('Step error from imported helper module');
}

/** Step that throws an error - tests cross-file step error stack traces */
export async function stepThatThrowsFromHelper() {
  'use step';
  throwErrorFromStep();
  return 'never reached';
}
stepThatThrowsFromHelper.maxRetries = 0;
