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
 * against a replay-stable time anchor. A healthy wait completes within
 * seconds of its target time; read staleness is bounded in seconds too. The
 * anchor differs per site:
 *
 *  - `wait_completed` (the elapsed-wait pass): the wait's `resumeAt`, adopted
 *    from the durable `wait_created` row, so it is the same on every wake.
 *    Before `resumeAt` nothing is attempted; past it, within the threshold:
 *    warn (visible in logs and as a span attribute) but keep today's
 *    behavior; past the threshold: fail the run as CORRUPTED_EVENT_LOG.
 *  - `wait_created` (the suspension handler): `resumeAt` CANNOT anchor this
 *    site — an uncreated wait's `resumeAt` is recomputed from the live clock
 *    on every replay, so it always sits in the future. The anchor is the
 *    scheduling instant embedded in the wait's replay-stable correlation id
 *    ({@link decodeWaitScheduledAtMs}). Within the threshold: silent, exactly
 *    as today (creation conflicts are the ordinary concurrent-suspension
 *    race). Past it, the contradiction is verified with a fresh log read
 *    ({@link isWaitCreatedRowReadable}) before failing, so a concurrent
 *    writer's row that landed after this replay's snapshot can never be
 *    mistaken for a wedge.
 *
 * Failing beats looping: the entity state and the event log provably
 * disagree, and looping cannot fix it. A failed run is visible and can be
 * re-run; the silent loop is neither.
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
 * The replay-stable instant a wait was first scheduled, decoded from the ULID
 * embedded in its correlation id (`wait_<ulid>`). The id is generated from the
 * workflow VM's seeded RNG and replay-stable clock, so every replay of the
 * same wait derives the same id — which makes its timestamp the one time
 * anchor a `wait_created` wedge cannot reset. (The wait's `resumeAt` cannot
 * anchor that site: an uncreated wait's `resumeAt` is recomputed from the live
 * clock on every replay, so it sits in the future on every observation.)
 */
export function decodeWaitScheduledAtMs(
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
 * conflict whose wait id is older than the escalation threshold), as the
 * fresh-read verification that separates a genuine wedge from a concurrent
 * writer's row landing after the caller's snapshot was taken.
 *
 * Fail-open: an unbounded log scan is declined (`true`, "readable") past the
 * page cap, and so is a read error — a spurious run failure is worse than one
 * more loop iteration.
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
 * The operator-facing explanation attached to the CorruptedEventLogError both
 * detection sites throw. One string builder so the two sites cannot drift.
 * `anchor` names the time base of the measurement: the wait's target time for
 * a wedged completion, or the wait id's replay-stable scheduling instant for
 * a wedged creation (whose `resumeAt` is recomputed each replay and therefore
 * cannot serve as an anchor).
 */
export function waitWedgeErrorMessage(args: {
  runId: string;
  correlationId: string;
  eventType: 'wait_created' | 'wait_completed';
  anchor: 'resumeAt' | 'scheduledAt';
  anchorMs: number;
  nowMs: number;
}): string {
  const { runId, correlationId, eventType, anchor, anchorMs, nowMs } = args;
  const secondsPast = Math.round((nowMs - anchorMs) / 1000);
  const anchorDescription =
    anchor === 'resumeAt'
      ? `${secondsPast}s after the wait's resumeAt`
      : `${secondsPast}s after the wait was first scheduled`;
  return (
    `Wait "${correlationId}" of run ${runId} is wedged: the World reports its ` +
    `${eventType} event already exists (409 conflict), but no ${eventType} row ` +
    `can be read back from the event log ${anchorDescription}. The wait ` +
    `entity and the event log disagree, so replay can never observe the wait ` +
    `and the run would otherwise wake-loop forever. This indicates a ` +
    `partially committed wait write on the backend (entity persisted, event ` +
    `row lost); backend-side backfill heals this class of wedge, after which ` +
    `the run can be re-run from the dashboard.`
  );
}
