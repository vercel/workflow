import { runtimeLogger } from '../logger.js';
import type { StepExecutionResult } from './step-executor.js';

/**
 * In-process single-flight for step body execution, keyed by
 * `runId:correlationId`.
 *
 * This is a required companion to inline step ownership (see
 * `isInlineOwnershipEnabled` in constants.ts): the ownership lease is a
 * *death proof* only on platforms with a bounded invocation lifetime. On
 * worlds without an invocation kill bound (world-local's single process,
 * self-hosted deployments) a delayed backstop can fire while the owning
 * execution is still mid-body — in the same process. This map absorbs that
 * race: the loser awaits the winner's settlement and then acks WITHOUT
 * executing. On Vercel Fluid compute it also absorbs same-instance races
 * between an owner redelivery and a backstop.
 *
 * The loser must not ack-and-skip early (before the winner settles): a crash
 * after an early ack would consume the loser's queue message while the
 * winner's outcome is still unknown, potentially orphaning the step with no
 * message left to drive it. Awaiting settlement first keeps the at-least-once
 * envelope intact — if the loser's own invocation hits its deadline while
 * waiting, its message redelivers and re-checks, degrading gracefully to
 * polling.
 *
 * Cross-instance duplicates (two separate processes racing the same step)
 * are out of scope here — that is what the ownership lease bounds on
 * platforms where it is a death proof, and the documented residual risk on
 * multi-instance self-hosted worlds (mitigate by raising
 * `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`).
 */
const inFlightSteps = new Map<string, Promise<StepExecutionResult>>();

/**
 * Run `execute` unless an execution for the same run + step correlation ID is
 * already in flight in this process. The winner's result is returned to the
 * winner; a loser awaits the winner's settlement (success OR failure) and
 * then returns `{ type: 'skipped' }` so its caller acks without running the
 * body. A winner failure is not propagated to the loser — the winner's own
 * queue message redelivers and drives the retry, so exactly one message
 * keeps owning the outcome.
 */
export async function runStepSingleFlight(
  runId: string,
  correlationId: string,
  execute: () => Promise<StepExecutionResult>
): Promise<StepExecutionResult> {
  const key = `${runId}:${correlationId}`;
  const existing = inFlightSteps.get(key);
  if (existing) {
    // warn (always printed, unlike debug/info): the single-flight is
    // absorbing what would have been a duplicate execution — typically a
    // delayed backstop or retry message landing in the same process while
    // the owner is still mid-body. Rare by design; a burst of these means
    // leases are expiring under live executions (raise
    // WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS).
    runtimeLogger.warn(
      'Step execution already in flight in this process; awaiting its settlement instead of executing again',
      { workflowRunId: runId, stepId: correlationId }
    );
    try {
      await existing;
    } catch {
      // The winner failed (typically a transient world error). Its own queue
      // message redelivers and retries; this loser still just skips.
    }
    return { type: 'skipped' };
  }

  const promise = execute();
  inFlightSteps.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightSteps.delete(key);
  }
}
