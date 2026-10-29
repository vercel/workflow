import { runSingleFlight } from '../step-single-flight.js';
import type { StepExecutionResult } from './step-executor.js';

/**
 * Single-flight for a step body. This is a required companion to inline step
 * ownership (see `isInlineOwnershipEnabled` in `./constants.ts`): the
 * ownership lease is a *death proof* only on platforms with a bounded
 * invocation lifetime. On worlds without an invocation kill bound
 * (world-local's single process, self-hosted deployments) a delayed backstop
 * can fire while the owning execution is still mid-body, in the same process.
 * This absorbs that race: the loser awaits the winner's settlement and then
 * acks WITHOUT executing (a `skipped` result). On Vercel Fluid compute it also
 * absorbs same-instance races between an owner redelivery and a backstop.
 *
 * A winner failure is not propagated to the loser: the winner's own queue
 * message redelivers and drives the retry, so exactly one message keeps
 * owning the outcome. If the loser's own invocation hits its deadline while
 * waiting, its message redelivers and re-checks, degrading gracefully to
 * polling.
 *
 * The exception is a winner that itself came back `skipped`. That outcome
 * means it never ran the body: its claim lost to a concurrent writer, or the
 * step had already settled. It owned nothing, so nothing on its side will
 * drive the step, and the loser may be the very execution the claim lost to
 * (say, the queued step message of the replay that created the step, while a
 * racing replay of the same run tried to claim it inline). Skipping with it
 * would leave the step created and never run. The loser runs its own attempt
 * instead, which its claim gates like any other.
 *
 * Cross-instance duplicates are what the ownership lease bounds on platforms
 * where it is a death proof, and the documented residual risk on
 * multi-instance self-hosted worlds (mitigate by raising
 * `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`).
 */
export function runStepSingleFlight(
  runId: string,
  correlationId: string,
  execute: () => Promise<StepExecutionResult>,
  logLevel: 'debug' | 'warn' = 'warn'
): Promise<StepExecutionResult> {
  return runSingleFlight(
    runId,
    correlationId,
    execute,
    () => ({ type: 'skipped' }),
    logLevel,
    (winner) => winner.type === 'skipped'
  );
}
