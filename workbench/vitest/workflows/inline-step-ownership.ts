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

/**
 * Step whose side effect (an appended marker line) happens at the TOP of the
 * body, so the marker counts body entries rather than completed attempts.
 */
async function slowEntryMarkerStep(markerPath: string) {
  'use step';
  await appendFile(markerPath, 'entered\n');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return 'done';
}

/**
 * Regression workflow for issue #3909: a step-only workflow runs its first
 * delivery in turbo mode with a lazy inline step. A redelivery of the same
 * start message while the body is still running (world-local's transport
 * timeout, or any at-least-once duplicate) re-enters turbo at attempt 1 and
 * must not execute the body a second time.
 */
export async function inlineStepDuringRedeliveryWorkflow(markerPath: string) {
  'use workflow';

  return await slowEntryMarkerStep(markerPath);
}
