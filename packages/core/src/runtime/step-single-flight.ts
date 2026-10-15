import { globalSingleton } from '@workflow/utils';
import { runtimeLogger } from '../logger.js';

/**
 * In-process single-flight for step body execution, keyed by
 * `runId:correlationId`: two executions of one step in one process are two
 * deliveries racing for its body. The loser awaits the winner's settlement
 * (success or failure) and then returns what its caller chose for a loser,
 * without running the body. Each orchestrator wraps this with its own loser
 * outcome; see `spec8/step-single-flight.ts` and `spec9/step-single-flight.ts`.
 *
 * The loser must not return early (before the winner settles): its caller
 * would act on its message while the winner's outcome is still unknown.
 * Cross-instance duplicates (two processes racing one step) are not covered.
 */
// On `globalThis` (see `globalSingleton`), not module scope: a per-copy map is
// not single-flight. Two invocations reaching this module through different
// bundler layers would each believe they were the only one in the process and
// both run the step body, degrading in-process dedup to the cross-process
// residual the doc above scopes out.
const singleFlight = globalSingleton(
  '@workflow/core//stepSingleFlight',
  1,
  () => ({ inFlight: new Map<string, Promise<unknown>>() })
);

/**
 * Run `execute` unless an execution for the same run + step correlation ID is
 * already in flight in this process; a loser gets `loserResult()` once the
 * winner settled.
 */
export async function runSingleFlight<R>(
  runId: string,
  correlationId: string,
  execute: () => Promise<R>,
  loserResult: () => R,
  logLevel: 'debug' | 'warn' = 'warn'
): Promise<R> {
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
      // The winner failed (typically a transient world error). The loser's
      // outcome does not depend on how the winner settled.
    }
    return loserResult();
  }

  const promise = execute();
  singleFlight.inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    singleFlight.inFlight.delete(key);
  }
}
