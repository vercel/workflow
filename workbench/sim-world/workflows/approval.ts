import { createHook, sleep } from 'workflow';

async function reserveInventory(documentId: string) {
  'use step';
  return `reserved:${documentId}`;
}

async function settleOrder(reservation: string, approved: boolean) {
  'use step';
  return approved ? `settled:${reservation}` : `released:${reservation}`;
}

/**
 * A step and a hook suspend together.
 *
 * This is the shape the timing control exists for: the run has an in-flight
 * step *and* an open hook at the same moment, so where the `hook_received`
 * event lands relative to `step_started` / `step_completed` is a real
 * ordering choice rather than an artifact of whoever won the race. A
 * scenario pins that choice with a cue on the exact world call that commits
 * the step event.
 */
export async function approvalWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean; reviewer: string }>({
    token: `approval:${documentId}`,
  });

  const [reservation, decision] = await Promise.all([
    reserveInventory(documentId),
    hook,
  ]);

  const status = await settleOrder(reservation, decision.approved);
  return { status, reviewer: decision.reviewer };
}

/**
 * Approval with a deadline: whichever of the hook and the timer resolves
 * first decides the outcome.
 *
 * Under a real world this is genuinely racy and therefore untestable; here
 * the hook only arrives if a cue delivers it, and the timer only fires when
 * the scheduler jumps the clock to it, so both branches are reachable on
 * demand.
 */
export async function approvalWithDeadlineWorkflow(
  documentId: string,
  deadline: string
) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `approval:${documentId}`,
  });

  const decision = await Promise.race([
    hook.then((payload) => (payload.approved ? 'approved' : 'rejected')),
    sleep(deadline as never).then(() => 'timed-out' as const),
  ]);

  return decision;
}

/**
 * Waits on a hook with nothing else to wake it. Used to pin down what the
 * simulator does when external input never arrives: report a stall with the
 * open hook named, rather than hang.
 */
export async function blockedOnHookWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `approval:${documentId}`,
  });

  const decision = await hook;
  return decision.approved;
}

/**
 * Two sequential steps, then the hook is awaited.
 *
 * Useful for cues keyed on *execution state* rather than on a single event:
 * "deliver once both steps have completed" is a predicate over the world, and
 * it lands the payload before the workflow ever awaits the hook.
 */
export async function stagedApprovalWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `approval:${documentId}`,
  });

  const reservation = await reserveInventory(documentId);
  const settled = await settleOrder(reservation, true);
  const decision = await hook;

  return `${settled}/${decision.approved ? 'confirmed' : 'reverted'}`;
}
