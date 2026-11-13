import { runSingleFlight } from '../step-single-flight.js';
import type { StepExecutionResult } from './step-executor.js';

/**
 * Single-flight for a step body. This is a required companion to inline step
 * ownership (see `getInlineOwnershipLeaseSeconds` in `./constants.ts`): the
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
 * The other exception is a winner's `retry` that was folded into the
 * loser's own message: see `carryFoldedRetry`.
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
  options: StepSingleFlightOptions = {}
): Promise<StepExecutionResult> {
  return runSingleFlight<StepExecutionResult, FoldedRetry>(
    runId,
    correlationId,
    execute,
    async (winner) => {
      if (
        winner?.settled.type === 'retry' &&
        options.carryFoldedRetry &&
        winner.state.publishedAfter &&
        !winner.state.carried
      ) {
        winner.state.carried = true;
        await winner.state.publishedAfter;
        return winner.settled;
      }
      return { type: 'skipped' };
    },
    options.logLevel,
    (winner) => winner.type === 'skipped',
    {
      publishedAfter: options.retryPublishedUnderDispatchKeyAfter,
      carried: false,
    }
  );
}

export interface StepSingleFlightOptions {
  /**
   * Level of the contention log when this call loses. Fresh inline claims
   * overlap during ordinary wake replays, so they log at `debug`; recovery
   * callers keep `warn`, since repeated overlap can indicate expiring leases.
   */
  logLevel?: 'debug' | 'warn';
  /**
   * Set by a winner that publishes its own `retry` under the step's dispatch
   * key (stepDispatchIdempotencyKey): the node engine's inline executions.
   * The promise settles once that publish is durable, or once the delivery
   * that owns the execution ended without making it (a throttled batch
   * hands the step to its continuation's replay instead). A queued delivery
   * of the same step that is waiting on it was published under that same key
   * and is still in flight, so the queue folds the retry into it
   * (world-local returns the in-flight message's id, queues dedupe a key
   * while its message is in flight, and world-postgres replaces an unlocked
   * job with the same key or drops a later job whose key it has already
   * completed). The QuickJS engine publishes its retries under their own
   * keys, so its winners leave this unset.
   */
  retryPublishedUnderDispatchKeyAfter?: Promise<unknown>;
  /**
   * Set by the queued-step delivery. When it loses to a winner that sets
   * `retryPublishedUnderDispatchKeyAfter` and that winner returns `retry`, it
   * waits for that promise and then returns the `retry` instead of `skipped`,
   * so its message redelivers after the backoff and runs the attempt the
   * folded publish can no longer drive (workflow#4728). Waiting keeps the
   * message in flight until the publish is out, so the publish never lands on
   * a key the message already spent by acking (a sibling of the winner that
   * outlasts the backoff would otherwise let the carried attempt finish and
   * ack first). At most one loser carries a given retry.
   */
  carryFoldedRetry?: boolean;
}

/** The winner side of `carryFoldedRetry`, shared by its losers. */
interface FoldedRetry {
  publishedAfter: Promise<unknown> | undefined;
  carried: boolean;
}
