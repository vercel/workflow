/**
 * Wait-wedge detection: classify an EntityConflictError on a wait event write
 * whose row cannot be read back from the event log.
 *
 * On worlds that persist the wait entity and the event-log row in separate
 * writes (world-vercel), a request can commit the entity and then fail before
 * the row insert. Every retry of the event write then conflicts (409) against
 * the committed entity while the log stays permanently short one row. The
 * conflict is indistinguishable from the benign concurrent-handler race at the
 * moment it happens — but the two diverge on what the log shows afterwards:
 *
 *  - Benign race: another handler's write landed, so a reload finds the row
 *    and the replay advances. Silent, as always.
 *  - Wedge: no reload ever finds the row. `sleep()` resolves only from a
 *    `wait_completed` row (see workflow/sleep.ts) and the elapsed-wait pass
 *    can only complete waits whose `wait_created` row it can see, so the run
 *    replays into the same conflict forever — a ~1s wake loop (each pass past
 *    `resumeAt` arms a fresh second-bucketed continuation; see
 *    wait-continuation.ts) that never errors and never completes.
 *
 * Detection has to be STATELESS: every wake of the loop is a fresh queue
 * message, so there is no counter to persist across invocations. What IS
 * derivable on every observation is how long the contradiction has persisted
 * against a replay-stable time anchor — and only ONE of the two sites has a
 * per-wait anchor:
 *
 *  - `wait_completed` (the elapsed-wait pass): the wait's `resumeAt`, adopted
 *    from the durable `wait_created` row, so it is the same on every wake.
 *    Before `resumeAt` nothing is attempted; past it, within the threshold:
 *    warn (visible in logs and as a span attribute) but keep today's
 *    behavior; past the threshold: fail the run as CORRUPTED_EVENT_LOG.
 *    Failing beats looping here: the entity state and the event log provably
 *    disagree, and looping cannot fix it. A failed run is visible and can be
 *    re-run; the silent loop is neither.
 *  - `wait_created` (the suspension handler): WARN-ONLY, because no per-wait
 *    replay-stable time anchor exists for an uncreated wait. Its `resumeAt`
 *    is recomputed from the live clock on every replay (always in the
 *    future), and the ULID inside its correlation id encodes the RUN's
 *    creation epoch, not the wait's scheduling instant — the workflow VM
 *    mints every correlation id as `ulid(fixedTimestamp)` (see workflow.ts),
 *    a run-wide constant, precisely so ids are replay-stable. Escalating to
 *    a run failure on that anchor would kill any sufficiently old run on a
 *    single benign concurrent-suspension race. The run epoch is still useful
 *    as a cheap PRE-FILTER ({@link decodeWaitIdRunEpochMs}): a conflict in a
 *    run younger than the threshold is skipped for free, and only old runs
 *    pay the fresh-read verification ({@link isWaitCreatedRowReadable}) that
 *    gates the warning. Terminating a genuinely stale `wait_created` wedge
 *    is owned by the backend (wedge backfill heals fresh ones; the stale
 *    tier cancels the run), which can classify the wedge against entity
 *    state the SDK cannot see.
 */

import { envNumber, type World } from '@workflow/world';
import { decodeTime } from 'ulid';

/**
 * Default seconds past a wait's `resumeAt` after which a persistent
 * conflict-with-missing-row fails the run. Generous on purpose: eventually
 * consistent reads settle in seconds, so ten minutes cannot plausibly be
 * staleness.
 */
export const WAIT_WEDGE_FAIL_AFTER_SECONDS = 600;

/** Effective threshold. Override: `WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS`. */
export const getWaitWedgeFailAfterSeconds = (): number =>
  envNumber(
    'WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS',
    WAIT_WEDGE_FAIL_AFTER_SECONDS,
    { integer: true, min: 1 }
  );

export type WaitWedgeObservation = 'silent' | 'warn' | 'fail';

/**
 * The RUN's creation epoch, decoded from the ULID embedded in a wait's
 * correlation id (`wait_<ulid>`). The workflow VM mints every correlation id
 * as `ulid(fixedTimestamp)` — the run's creation time, held constant so ids
 * are replay-stable — which means this timestamp says nothing about when the
 * individual wait was scheduled. It is ONLY a lower bound on the run's age,
 * usable as a cheap pre-filter (a conflict in a young run cannot be an old
 * wedge), never as a per-wait anchor for escalation.
 */
export function decodeWaitIdRunEpochMs(
  correlationId: string
): number | undefined {
  if (!correlationId.startsWith('wait_')) return undefined;
  try {
    return decodeTime(correlationId.slice('wait_'.length));
  } catch {
    return undefined;
  }
}

/**
 * Whether a fresh read of the run's event log can produce a `wait_created`
 * row for the given wait. Called on the suspected-wedge path only (a create
 * conflict in a run older than the threshold — see
 * {@link decodeWaitIdRunEpochMs}), as the fresh-read verification that
 * separates a genuine wedge from a concurrent writer's row landing after the
 * caller's snapshot was taken. It gates the WARNING only — the
 * `wait_created` site never fails the run (see the module doc).
 *
 * Fail-open: an unbounded log scan is declined (`true`, "readable") past the
 * page cap, and so is a read error — a spurious wedge warning is worse than
 * one more silent loop iteration.
 */
export async function isWaitCreatedRowReadable(
  world: World,
  runId: string,
  correlationId: string
): Promise<boolean> {
  const MAX_SCAN_PAGES = 200;
  try {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const result = await world.events.list({
        runId,
        pagination: { sortOrder: 'asc', ...(cursor ? { cursor } : {}) },
        resolveData: 'none',
      });
      if (
        result.data.some(
          (event) =>
            event.eventType === 'wait_created' &&
            event.correlationId === correlationId
        )
      ) {
        return true;
      }
      if (!result.hasMore || !result.cursor) {
        return false;
      }
      cursor = result.cursor;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Classify one observation of "a wait event write conflicted and the log
 * cannot produce the row it conflicted with".
 */
export function classifyWaitWedgeObservation(args: {
  /** The wait's target time (`resumeAt`), in epoch ms. */
  resumeAtMs: number;
  /** Observation time, in epoch ms. */
  nowMs: number;
}): WaitWedgeObservation {
  const { resumeAtMs, nowMs } = args;
  if (nowMs < resumeAtMs) {
    return 'silent';
  }
  const thresholdMs = getWaitWedgeFailAfterSeconds() * 1000;
  return nowMs - resumeAtMs > thresholdMs ? 'fail' : 'warn';
}

/**
 * The operator-facing explanation attached to the CorruptedEventLogError the
 * `wait_completed` detection site throws. (The `wait_created` site is
 * warn-only — see the module doc — so this is the one failure text.)
 */
export function waitWedgeErrorMessage(args: {
  runId: string;
  correlationId: string;
  resumeAtMs: number;
  nowMs: number;
}): string {
  const { runId, correlationId, resumeAtMs, nowMs } = args;
  const secondsPast = Math.round((nowMs - resumeAtMs) / 1000);
  return (
    `Wait "${correlationId}" of run ${runId} is wedged: the World reports its ` +
    `wait_completed event already exists (409 conflict), but no wait_completed ` +
    `row can be read back from the event log ${secondsPast}s after the wait's ` +
    `resumeAt. The wait entity and the event log disagree, so replay can ` +
    `never observe the wait and the run would otherwise wake-loop forever. ` +
    `This indicates a partially committed wait write on the backend (entity ` +
    `persisted, event row lost); backend-side backfill heals this class of ` +
    `wedge, after which the run can be re-run from the dashboard.`
  );
}
