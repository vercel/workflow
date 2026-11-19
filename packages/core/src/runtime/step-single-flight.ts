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
  2,
  () => ({ inFlight: new Map<string, InFlightExecution>() })
);

interface InFlightExecution {
  settlement: Promise<unknown>;
  /** The winner's `winnerState`, handed to each loser's `loserResult`. */
  state: unknown;
  /**
   * The winner entered at `debug`: an inline execution whose caller expects
   * overlap (a fresh claim racing an ordinary wake replay). Optional so the map
   * stays shared with copies of this module that predate it.
   */
  quiet?: boolean;
}

/** A settled winner, as a loser's `loserResult` sees it. */
export interface SingleFlightWinner<R, S> {
  settled: R;
  state: S;
}

/**
 * Run `execute` unless an execution for the same run + step correlation ID is
 * already in flight in this process; a loser gets `loserResult()` once the
 * winner settled, unless `rerunAfter(winner)` says the winner ran nothing, in
 * which case the loser re-enters and tries the step itself.
 *
 * `winnerState` is kept with this call's execution if it wins, and each loser's
 * `loserResult` gets it with the winner's result (`undefined` when the winner
 * rejected). A loser may mutate it, to coordinate with the other losers.
 */
export async function runSingleFlight<R, S = undefined>(
  runId: string,
  correlationId: string,
  execute: () => Promise<R>,
  loserResult: (winner: SingleFlightWinner<R, S> | undefined) => R | Promise<R>,
  logLevel: 'debug' | 'warn' = 'warn',
  rerunAfter?: (winner: R) => boolean,
  winnerState?: S
): Promise<R> {
  const key = `${runId}:${correlationId}`;
  const existing = singleFlight.inFlight.get(key);
  if (existing) {
    // Inline executions overlap during ordinary wake replays, whichever side
    // loses: a queued delivery of a step an inline claim is already running
    // is the same race (workflow#4545). Only contention where neither side
    // expects overlap (queued or owned recovery) warns: repeated overlap there
    // can indicate expiring leases.
    const level = existing.quiet ? 'debug' : logLevel;
    runtimeLogger[level](
      'Step execution already in flight in this process; awaiting its settlement instead of executing again',
      { workflowRunId: runId, stepId: correlationId }
    );
    let winner: SingleFlightWinner<R, S> | undefined;
    try {
      winner = {
        settled: (await existing.settlement) as R,
        state: existing.state as S,
      };
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
        rerunAfter,
        winnerState
      );
    }
    return loserResult(winner);
  }

  const promise = execute();
  singleFlight.inFlight.set(key, {
    settlement: promise,
    state: winnerState,
    quiet: logLevel === 'debug',
  });
  try {
    return await promise;
  } finally {
    singleFlight.inFlight.delete(key);
  }
}
