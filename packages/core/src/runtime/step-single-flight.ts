import { globalSingleton } from '@workflow/utils';
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
 * execution is still mid-body, in the same process. This map absorbs that
 * race: the loser awaits the winner's settlement and then acks WITHOUT
 * executing. On Vercel Fluid compute it also absorbs same-instance races
 * between an owner redelivery and a backstop.
 *
 * The loser must not ack-and-skip early (before the winner settles): a crash
 * after an early ack would consume the loser's queue message while the
 * winner's outcome is still unknown, potentially orphaning the step with no
 * message left to drive it. Awaiting settlement first keeps the at-least-once
 * envelope intact: if the loser's own invocation hits its deadline while
 * waiting, its message redelivers and re-checks, degrading gracefully to
 * polling.
 *
 * Cross-instance duplicates (two separate processes racing the same step)
 * are out of scope here; that is what the ownership lease bounds on
 * platforms where it is a death proof, and the documented residual risk on
 * multi-instance self-hosted worlds (mitigate by raising
 * `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`).
 */
// On `globalThis` (see `globalSingleton`), not module scope: a per-copy map is
// not single-flight. Two invocations reaching this module through different
// bundler layers would each believe they were the only one in the process and
// both run the step body, degrading in-process dedup to the cross-process
// residual the doc above scopes out.
const singleFlight = globalSingleton(
  '@workflow/core//stepSingleFlight',
  2,
  () => ({ inFlight: new Map<string, InFlightStepExecution>() })
);

interface InFlightStepExecution {
  settlement: Promise<StepExecutionResult>;
  retryPublishedUnderDispatchKeyAfter: Promise<unknown> | undefined;
  retryCarried: boolean;
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
   * key (stepDispatchIdempotencyKey) once this promise settles: the node
   * engine's inline executions, which publish after their whole inline batch
   * settles. A queued delivery of the same step that is waiting on it was
   * published under that same key and is still in flight, so the queue folds
   * the retry into it (world-local returns the in-flight message's id, queues
   * dedupe a key while its message is in flight, and world-postgres replaces
   * an unlocked job with the same key or drops a later job whose key it has
   * already completed). The QuickJS engine publishes its retries under their
   * own keys, so its winners leave this unset.
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

/**
 * Run `execute` unless an execution for the same run + step correlation ID is
 * already in flight in this process. The winner's result is returned to the
 * winner; a loser awaits the winner's settlement (success OR failure) and
 * then returns `{ type: 'skipped' }` so its caller acks without running the
 * body. A winner failure is not propagated to the loser: the winner's own
 * queue message redelivers and drives the retry, so exactly one message
 * keeps owning the outcome.
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
 */
export async function runStepSingleFlight(
  runId: string,
  correlationId: string,
  execute: () => Promise<StepExecutionResult>,
  options: StepSingleFlightOptions = {}
): Promise<StepExecutionResult> {
  const key = `${runId}:${correlationId}`;
  const existing = singleFlight.inFlight.get(key);
  if (existing) {
    runtimeLogger[options.logLevel ?? 'warn'](
      'Step execution already in flight in this process; awaiting its settlement instead of executing again',
      { workflowRunId: runId, stepId: correlationId }
    );
    let settled: StepExecutionResult | undefined;
    try {
      settled = await existing.settlement;
    } catch {
      // The winner failed (typically a transient world error). Its own queue
      // message redelivers and retries; this loser still skips.
    }
    if (settled?.type === 'skipped') {
      // The winner ran nothing (see above), so try the step here. Re-enter
      // rather than call `execute` directly: another caller may have taken
      // the slot while this one waited.
      return runStepSingleFlight(runId, correlationId, execute, options);
    }
    if (
      settled?.type === 'retry' &&
      options.carryFoldedRetry &&
      existing.retryPublishedUnderDispatchKeyAfter &&
      !existing.retryCarried
    ) {
      existing.retryCarried = true;
      await existing.retryPublishedUnderDispatchKeyAfter;
      return settled;
    }
    return { type: 'skipped' };
  }

  const execution: InFlightStepExecution = {
    settlement: execute(),
    retryPublishedUnderDispatchKeyAfter:
      options.retryPublishedUnderDispatchKeyAfter,
    retryCarried: false,
  };
  singleFlight.inFlight.set(key, execution);
  try {
    return await execution.settlement;
  } finally {
    singleFlight.inFlight.delete(key);
  }
}
