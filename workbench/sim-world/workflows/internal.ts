/**
 * A fork decided entirely by events the run writes itself — no hook, no
 * external writer, no timer.
 *
 * Two steps suspend together and race. The winner is whichever `step_completed`
 * sits earlier in the log, so the branch is a function of log order exactly as
 * the hook races were. The point of this shape is to show that "the log and the
 * execution disagree" does not require an out-of-band event type: it requires
 * only two events whose relative order decides a branch, plus a reader that
 * missed one of them.
 */

async function fast(documentId: string) {
  'use step';
  return `fast:${documentId}`;
}

async function slow(documentId: string) {
  'use step';
  return `slow:${documentId}`;
}

async function afterFast(documentId: string) {
  'use step';
  return `afterFast:${documentId}`;
}

async function afterSlow(documentId: string) {
  'use step';
  return `afterSlow:${documentId}`;
}

export async function stepVsStepForkWorkflow(documentId: string) {
  'use workflow';

  const winner = await Promise.race([
    fast(documentId).then(() => 'fast' as const),
    slow(documentId).then(() => 'slow' as const),
  ]);

  return winner === 'fast'
    ? await afterFast(documentId)
    : await afterSlow(documentId);
}
