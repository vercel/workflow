import { FatalError, RUN_ERROR_CODES } from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { describeError } from '../describe-error.js';
import { runtimeLogger } from '../logger.js';
import { dehydrateRunError } from '../serialization.js';
import { getReplayTimeoutMaxRetries, getReplayTimeoutMs } from './constants.js';
import { memoizeEncryptionKey } from './helpers.js';
import { getWorld } from './world.js';

/**
 * Per-invocation accounting of the *non-step* portion of a workflow
 * handler run: deterministic event-log replay, workflow-VM execution
 * between step boundaries, suspension handling, queue round-trips, etc.
 * Inline step bodies (`"use step"` functions invoked via `executeStep`)
 * are intentionally excluded — they are bounded by the platform's
 * function `maxDuration` and the `NO_INLINE_REPLAY_AFTER_MS` early-return
 * guard.
 *
 * Usage:
 *
 * ```ts
 * const budget = new ReplayBudget();
 * // …non-step work happens here, accumulates against the budget…
 * budget.pause();
 * try {
 *   await executeStep(...); // not charged
 * } finally {
 *   budget.resume();
 * }
 * // back to charging
 * if (budget.isExhausted()) { ... }
 * ```
 *
 * Implementation notes:
 *
 * - `pause()` and `resume()` are idempotent: calling `pause()` while
 *   already paused (or `resume()` while already resumed) is a no-op.
 *   This protects against double-counting in future refactors that nest
 *   step execution or take an early-return path between a `pause()` and
 *   the matching `resume()`.
 * - `isExhausted()` is checked at loop boundaries by the caller — the
 *   budget itself does not arm any timers. This means an in-flight
 *   pathological `runWorkflow` call (e.g. a huge event-log replay) can
 *   overshoot the budget by up to one iteration's worth of work before
 *   the next check fires. In practice the 20s headroom built into
 *   `MAX_REPLAY_TIMEOUT_MS` (and the function `maxDuration` ceiling)
 *   gives us slack; the old `setTimeout`-based approach also ultimately
 *   relied on the platform SIGTERM as the hard backstop.
 */
export class ReplayBudget {
  private readonly limitMs: number;
  private elapsedMs = 0;
  private intervalStart: number | null;

  constructor(limitMs: number = getReplayTimeoutMs()) {
    this.limitMs = limitMs;
    this.intervalStart = Date.now();
  }

  /**
   * The configured replay-timeout limit, in ms. Useful for log messages.
   */
  get configuredLimitMs(): number {
    return this.limitMs;
  }

  /**
   * Total non-step time accumulated so far, in ms. Includes the
   * currently-active interval if the budget is not paused.
   */
  elapsed(): number {
    const open =
      this.intervalStart === null ? 0 : Date.now() - this.intervalStart;
    return this.elapsedMs + open;
  }

  /**
   * Stop counting elapsed time toward the budget. Idempotent — safe to
   * call multiple times in a row; subsequent calls are no-ops until
   * `resume()` reopens an interval.
   */
  pause(): void {
    if (this.intervalStart === null) return;
    this.elapsedMs += Date.now() - this.intervalStart;
    this.intervalStart = null;
  }

  /**
   * Resume counting elapsed time toward the budget. Idempotent — safe to
   * call multiple times in a row; subsequent calls re-anchor the
   * interval start to `now()`, which is fine because no time accrues
   * between back-to-back `resume()` calls.
   */
  resume(): void {
    this.intervalStart = Date.now();
  }

  /**
   * True if the budget has been exhausted (`elapsed() >= limitMs`).
   * Callers should invoke `handleExhausted(...)` afterward and return
   * from the handler.
   */
  isExhausted(): boolean {
    return this.elapsed() >= this.limitMs;
  }
}

export class ReplayTimeoutRetryError extends Error {
  override readonly name = 'ReplayTimeoutRetryError';
}

/**
 * Reject the current delivery while replay-timeout retries remain. Once
 * exhausted, fail the run and let the queue acknowledge the delivery.
 */
export async function handleReplayBudgetExhausted(args: {
  runId: string;
  workflowName: string;
  requestId: string | undefined;
  attempt: number;
  limitMs: number;
}): Promise<void> {
  const { runId, workflowName, requestId, attempt, limitMs } = args;
  const runLogger = runtimeLogger.forRun(runId, workflowName);

  const maxRetries = getReplayTimeoutMaxRetries();
  if (attempt <= maxRetries) {
    runLogger.warn('Workflow replay exceeded timeout; retrying delivery', {
      timeoutMs: limitMs,
      attempt,
      maxRetries,
    });
    throw new ReplayTimeoutRetryError(
      `Workflow replay exceeded maximum duration (${limitMs / 1000}s)`
    );
  }

  const world = await getWorld();

  const replayTimeoutDescription = describeError(
    undefined,
    RUN_ERROR_CODES.REPLAY_TIMEOUT
  );
  runLogger.error(
    'Workflow replay exceeded timeout and max retries exceeded. Failing the run',
    {
      timeoutMs: limitMs,
      attempt,
      maxRetries,
      errorCode: replayTimeoutDescription.errorCode,
      errorAttribution: replayTimeoutDescription.attribution,
    }
  );

  const getEncryptionKey = memoizeEncryptionKey(world, runId);
  const timeoutErr = new FatalError(
    `Workflow replay exceeded maximum duration (${limitMs / 1000}s) after ${attempt} attempts`
  );
  await world.events.create(
    runId,
    {
      eventType: 'run_failed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        error: await dehydrateRunError(
          timeoutErr,
          runId,
          await getEncryptionKey()
        ),
        errorCode: RUN_ERROR_CODES.REPLAY_TIMEOUT,
      },
    },
    { requestId }
  );
}
