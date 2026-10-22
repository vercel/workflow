import type { WorkflowInvokePayload } from '@workflow/world';
import { getWaitContinuationDispatch } from '../wait-continuation.js';

type WaitContinuation = NonNullable<WorkflowInvokePayload['waitContinuation']>;

/**
 * The timer message of a spec 9 wait, `seconds` before it is due.
 *
 * A wait longer than one queue delay (`getWaitContinuationDispatch`) is
 * reached in hops. Every hop but the last is an intermediate hop: it carries
 * the wait's deadline (`waitContinuation.resumeAtMs`), which tells the World
 * not to serialize or coalesce it (`isIntermediateWaitHop` in
 * `@workflow/world`), and its delivery only sends the next hop (see
 * `continueWaitHop` in `delivery.ts`). The last hop, due with the wait,
 * carries no deadline and is an ordinary orchestrator message: if the queue
 * coalesces it into a running delivery of the run, that delivery's re-run
 * finds the wait due and completes it.
 *
 * Spec 9 timers carry no idempotency key: nothing would dedupe them against
 * each other, and a key spent by an early delivery would drop the re-arm.
 */
export function waitTimerMessage(params: {
  correlationId: string;
  resumeAtMs: number;
  /** Seconds until the wait is due, as the caller rounds them. */
  seconds: number;
  nowMs: number;
  attempt?: number;
}): { waitContinuation: WaitContinuation; delaySeconds: number } {
  const { correlationId, resumeAtMs, seconds, nowMs, attempt = 0 } = params;
  const { delaySeconds } = getWaitContinuationDispatch(
    seconds,
    correlationId,
    nowMs,
    attempt
  );
  return {
    delaySeconds,
    waitContinuation: {
      correlationId,
      attempt,
      ...(delaySeconds < seconds ? { resumeAtMs } : {}),
    },
  };
}
