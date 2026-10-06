import { globalSingleton } from '@workflow/utils';
import { runtimeLogger } from '../logger.js';
import type { StepExecutionResult } from './step-executor.js';

/**
 * In-process single-flight for step body execution, keyed by
 * `runId:correlationId`.
 *
 * A step has one queue message, so two executions of one step in one process
 * are two deliveries of that message: the queue redelivered it while the
 * first delivery was still running the body (an event loop stalled past the
 * lease, or a world without an invocation kill bound). The second delivery
 * awaits the first one's settlement and then asks for the same message again
 * after a short delay instead of running the body. It never acknowledges on
 * the first one's behalf: the message is acknowledged only once a terminal
 * step event is committed, and the redelivery confirms that from the log.
 *
 * Cross-instance duplicates (two processes racing one step) are not covered.
 * Background step invocations are not fenced; such a duplicate runs the body
 * twice and is recorded as a `redelivery` start.
 */
// On `globalThis` (see `globalSingleton`), not module scope: a per-copy map is
// not single-flight. Two invocations reaching this module through different
// bundler layers would each believe they were the only one in the process and
// both run the step body, degrading in-process dedup to the cross-process
// residual the doc above scopes out.
const singleFlight = globalSingleton(
  '@workflow/core//stepSingleFlight',
  1,
  () => ({ inFlight: new Map<string, Promise<StepExecutionResult>>() })
);

/** Delay before a delivery that lost the single-flight is redelivered. */
export const STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS = 1;

/**
 * Run `execute` unless an execution for the same run + step correlation ID is
 * already in flight in this process. A loser awaits the winner's settlement
 * (success OR failure) and then returns a `throttled` result, so its caller
 * redelivers the message and the redelivery re-checks the log.
 */
export async function runStepSingleFlight(
  runId: string,
  correlationId: string,
  execute: () => Promise<StepExecutionResult>,
  logLevel: 'debug' | 'warn' = 'warn'
): Promise<StepExecutionResult> {
  const key = `${runId}:${correlationId}`;
  const existing = singleFlight.inFlight.get(key);
  if (existing) {
    // Fresh inline claims can overlap during ordinary wake replays. Recovery
    // callers keep warning: repeated overlap can indicate expiring leases.
    runtimeLogger[logLevel](
      'Step execution already in flight in this process; awaiting its settlement instead of executing again',
      { workflowRunId: runId, stepId: correlationId }
    );
    try {
      await existing;
    } catch {
      // The winner failed (typically a transient world error). The
      // redelivery below re-checks the log either way.
    }
    return {
      type: 'throttled',
      timeoutSeconds: STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS,
    };
  }

  const promise = execute();
  singleFlight.inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    singleFlight.inFlight.delete(key);
  }
}
