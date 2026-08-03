import { appendFile } from 'node:fs/promises';
import { createHook } from 'workflow';

/**
 * Step with an observable side effect (an appended marker line) and a body
 * long enough (~1.5s) that a hook resume can reliably land mid-execution.
 */
async function slowMarkerStep(markerPath: string) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await appendFile(markerPath, 'executed\n');
  return 'done';
}

/**
 * Regression workflow for issue #2780: a hook resume that wakes the run
 * while an inline step's body is still executing must not re-dispatch (and
 * so re-execute) that step. The hook and the step suspend together, the
 * step runs inline in the first invocation, and the test resumes the hook
 * mid-body — the wake replay must observe the step as inline-owned and only
 * ensure a delayed backstop instead of enqueueing an immediate duplicate.
 */
export async function inlineStepDuringHookResumeWorkflow(
  token: string,
  markerPath: string
) {
  'use workflow';

  const hook = createHook<{ n: number }>({ token });
  const [stepResult] = await Promise.all([slowMarkerStep(markerPath), hook]);
  return stepResult;
}
