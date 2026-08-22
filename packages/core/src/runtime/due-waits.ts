/**
 * Completing a run's due waits independently of its status.
 *
 * A pending `wait` (`sleep()`, a `Promise.race` timer) parks a delayed
 * continuation message on the workflow queue that fires when the wait comes
 * due; the delivery's job is to record the wait's `wait_completed` and let the
 * next replay advance past it (see runtime/wait-continuation.ts).
 *
 * That delivery can arrive at a run that has already finished — a raced
 * `Promise.race([sleep('1h'), hook])` whose hook won, a cancellation, a
 * failure. The handler has nothing left to replay in that case, but the wait's
 * completion still has to be recorded: the event log is the run's whole
 * history, and a `wait_created` with no `wait_completed` in it is an open wait
 * forever. Every reader of the log — replay, `inspect`, the dashboard's
 * timeline — then shows a run that terminated while still sleeping, and
 * anything deriving open-wait state from the log (see `openHookAndWaitState`)
 * counts a wait that can never resolve.
 *
 * So the completion is unconditional on run status, and on a terminal run it
 * is ALL the delivery does: no replay, no suspension dispatch, no new entities
 * — a terminal run rejects those anyway. The queue message is acknowledged
 * only after the write settles, so a transient World failure redelivers rather
 * than dropping the completion on the floor.
 *
 * Not-yet-due waits are left alone. Each one has (or will get) its own
 * continuation for its own deadline, and that delivery takes the same path
 * through here when it fires.
 */

import { EntityConflictError } from '@workflow/errors';
import {
  type Event,
  isLegacySpecVersion,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { isRetryableWorldError } from '../classify-error.js';
import { runtimeLogger } from '../logger.js';
import { loadWorkflowRunEvents } from './helpers.js';

/** A `wait_created` whose `resumeAt` has passed with no `wait_completed`. */
interface DueWait {
  correlationId: string;
  resumeAt: Date;
}

export interface DueWaitCompletionSummary {
  /** Waits this call recorded a `wait_completed` for. */
  completed: string[];
  /** Waits another writer had already completed. */
  alreadyCompleted: string[];
  /**
   * Waits the World refused to complete for a reason redelivery cannot fix —
   * an older backend that drops a terminal run's waits outright, so the
   * completion has nowhere to land. Logged and moved past: nacking the
   * delivery would burn every redelivery on a verdict that cannot change.
   */
  unrecordable: string[];
}

/**
 * `resumeAt` as a Date. Worlds hand back parsed events, but a `resumeAt` that
 * survived a JSON hop arrives as a string — a wait whose deadline cannot be
 * read is left alone rather than treated as due.
 */
function readResumeAt(value: unknown): Date | undefined {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** The run's waits that have come due and are still open in `events`. */
export function findDueWaits(events: Event[], now: number): DueWait[] {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'wait_completed')
      completed.add(event.correlationId);
  }
  const due: DueWait[] = [];
  for (const event of events) {
    if (event.eventType !== 'wait_created') continue;
    if (event.correlationId === undefined) continue;
    if (completed.has(event.correlationId)) continue;
    const resumeAt = readResumeAt(event.eventData?.resumeAt);
    if (!resumeAt || now < resumeAt.getTime()) continue;
    due.push({ correlationId: event.correlationId, resumeAt });
  }
  return due;
}

/** What one `wait_completed` write settled as. */
type WriteOutcome = 'completed' | 'alreadyCompleted' | 'unrecordable';

/**
 * Write one wait's `wait_completed`.
 *
 * Legacy runs take the shape `wakeUpRun` uses for them: no `specVersion`, no
 * `eventData`, and the `v1Compat` flag that routes the write to the World's
 * legacy handler.
 */
async function writeWaitCompleted(
  world: World,
  runId: string,
  wait: DueWait,
  v1Compat: boolean,
  requestId: string | undefined
): Promise<WriteOutcome> {
  try {
    await world.events.create(
      runId,
      v1Compat
        ? {
            eventType: 'wait_completed',
            correlationId: wait.correlationId,
          }
        : {
            eventType: 'wait_completed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: wait.correlationId,
            eventData: { resumeAt: wait.resumeAt },
          },
      { requestId, ...(v1Compat ? { v1Compat: true } : {}) }
    );
    return 'completed';
  } catch (err) {
    if (EntityConflictError.is(err)) return 'alreadyCompleted';
    // Retryable means the next delivery of this message can still land the
    // write, so let it nack. Anything else is a verdict redelivery would only
    // reproduce.
    if (isRetryableWorldError(err)) throw err;
    runtimeLogger.warn(
      'Wait came due but its completion could not be recorded',
      {
        workflowRunId: runId,
        correlationId: wait.correlationId,
        errorName: err instanceof Error ? err.name : 'UnknownError',
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    );
    return 'unrecordable';
  }
}

/**
 * Record `wait_completed` for every wait of `runId` that has come due.
 *
 * Resolves only once every due wait is either recorded, already recorded, or
 * provably unrecordable, so a caller can treat the resolution as permission to
 * acknowledge the delivery. Retryable World failures are rethrown for exactly
 * that reason.
 *
 * `events` is the caller's already-loaded log when it has one; otherwise the
 * log is read here. Nothing is written when no wait is due, which is the
 * overwhelmingly common case for a delivery that reaches a terminal run.
 */
export async function completeDueWaits({
  world,
  runId,
  events,
  specVersion,
  requestId,
  now = Date.now(),
}: {
  world: World;
  runId: string;
  events?: Event[];
  specVersion?: number;
  requestId?: string;
  now?: number;
}): Promise<DueWaitCompletionSummary> {
  const summary: DueWaitCompletionSummary = {
    completed: [],
    alreadyCompleted: [],
    unrecordable: [],
  };

  const log = events ?? (await loadWorkflowRunEvents(runId)).events;
  const due = findDueWaits(log, now);
  if (due.length === 0) return summary;

  const v1Compat = isLegacySpecVersion(specVersion ?? SPEC_VERSION_CURRENT);
  for (const wait of due) {
    const outcome = await writeWaitCompleted(
      world,
      runId,
      wait,
      v1Compat,
      requestId
    );
    summary[outcome].push(wait.correlationId);
  }

  if (summary.completed.length > 0) {
    runtimeLogger.debug('Completed due waits', {
      workflowRunId: runId,
      completed: summary.completed,
    });
  }
  return summary;
}
