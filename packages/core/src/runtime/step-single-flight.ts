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
// In-flight executions that entered at `debug`: fresh inline claims, whose
// overlap with another delivery is an ordinary wake race. A separate singleton
// (not a new field on the one above) so copies of this module from different
// package versions in one process still share `inFlight`.
const quietWinners = globalSingleton(
  '@workflow/core//stepSingleFlightQuietWinners',
  1,
  () => ({ executions: new WeakSet<Promise<unknown>>() })
);

/**
 * Run `execute` unless an execution for the same run + step correlation ID is
 * already in flight in this process; a loser gets `loserResult()` once the
 * winner settled, unless `rerunAfter(winner)` says the winner ran nothing, in
 * which case the loser re-enters and tries the step itself.
 */
export async function runSingleFlight<R>(
  runId: string,
  correlationId: string,
  execute: () => Promise<R>,
  loserResult: () => R,
  logLevel: 'debug' | 'warn' = 'warn',
  rerunAfter?: (winner: R) => boolean
): Promise<R> {
  const key = `${runId}:${correlationId}`;
  const existing = singleFlight.inFlight.get(key);
  if (existing) {
    // Fresh inline claims can overlap during ordinary wake replays, whichever
    // side loses: a queued delivery of a step that a fresh inline claim is
    // already running is the same race. Only contention between two
    // non-fresh executions (queued or owned recovery) warns: repeated overlap
    // there can indicate expiring leases.
    const level = quietWinners.executions.has(existing) ? 'debug' : logLevel;
    runtimeLogger[level](
      'Step execution already in flight in this process; awaiting its settlement instead of executing again',
      { workflowRunId: runId, stepId: correlationId }
    );
    let winner: { settled: R } | undefined;
    try {
      winner = { settled: (await existing) as R };
    } catch {
      // The winner failed (typically a transient world error). A failure
      // never makes the loser rerun: the winner's own message redelivers.
    }
    if (winner && rerunAfter?.(winner.settled)) {
      // Re-enter rather than call `execute` directly: another caller may
      // have taken the slot while this one waited.
      return runSingleFlight(
        runId,
        correlationId,
        execute,
        loserResult,
        logLevel,
        rerunAfter
      );
    }
    return loserResult();
  }

  const promise = execute();
  singleFlight.inFlight.set(key, promise);
  if (logLevel === 'debug') quietWinners.executions.add(promise);
  try {
    return await promise;
  } finally {
    singleFlight.inFlight.delete(key);
  }
}
