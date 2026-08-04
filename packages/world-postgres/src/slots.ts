/**
 * Slot identity for the postgres world.
 *
 * Runs name their events by position: `evnt_…001` is the first event of the
 * run, `evnt_…002` the second. Contention on a position is the
 * point — it is what makes a concurrent write detectable rather than silent —
 * so the two things this module has to get right are that a position is written
 * at most once and that a position this allocator loses is retried rather than
 * abandoned as a hole.
 *
 * The authority for both is the events table's primary key, `(run_id, id)`: the
 * INSERT either lands or raises a unique violation, and a writer that loses the
 * race is retried at a position that is still free rather than abandoning the
 * one it lost. The probe below is only ever a hint about where to try next.
 */

import { WorkflowWorldError } from '@workflow/errors';
import {
  FIRST_SLOT,
  SLOT_RETRY_BUDGET_MS,
  slotEventId,
  slotFromId,
  slotRetryDelay,
} from '@workflow/world';
import { and, desc, eq } from 'drizzle-orm';
import { type Drizzle, Schema } from './drizzle/index.js';

/**
 * The slot a run's own `run_created` occupies. Nothing in a run precedes its
 * creation, so this one position needs no allocation, and every other event of
 * the run searches above it — including the event that happens to reach storage
 * first, which on the start path is routinely `run_started`.
 */
export const RUN_CREATED_SLOT = FIRST_SLOT;

/** Postgres unique-violation code. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether an error says the position a write aimed at is already occupied.
 *
 * Drizzle wraps the pg error, so the code can sit on the error or on its cause.
 * Both the name drizzle generates for the composite key and the name postgres
 * gives an inline `PRIMARY KEY` are accepted, so a database whose key predates
 * the run-scoped migration still classifies correctly.
 */
export function isEventKeyViolation(error: unknown): boolean {
  const pg = (error as { code?: string; constraint?: string }).code
    ? (error as { code?: string; constraint?: string })
    : ((error as { cause?: { code?: string; constraint?: string } }).cause ??
      {});
  return (
    pg.code === UNIQUE_VIOLATION &&
    (pg.constraint === 'workflow_events_run_id_id_pk' ||
      pg.constraint === 'workflow_events_pkey')
  );
}

/**
 * The highest event id in a run's log, or undefined when the log is empty.
 *
 * One backwards scan of the `(run_id, id)` primary key. Ids are fixed-width
 * within a scheme, so the highest id names the highest written position. A log
 * holds ids of exactly one scheme, so that id also reports which scheme the run
 * was created with.
 */
export async function highestEventId(
  drizzle: Drizzle,
  runId: string
): Promise<string | undefined> {
  const [row] = await drizzle
    .select({ eventId: Schema.events.eventId })
    .from(Schema.events)
    .where(eq(Schema.events.runId, runId))
    .orderBy(desc(Schema.events.eventId))
    .limit(1);
  return row?.eventId;
}

/** The position an id names, or 0 for an empty log or a ULID-numbered one. */
export function highestSlotOf(eventId: string | undefined): number {
  return eventId === undefined ? 0 : (slotFromId(eventId) ?? 0);
}

/** Whether a run's log already holds `eventId`. */
export async function eventExists(
  drizzle: Drizzle,
  runId: string,
  eventId: string
): Promise<boolean> {
  const [row] = await drizzle
    .select({ eventId: Schema.events.eventId })
    .from(Schema.events)
    .where(
      and(eq(Schema.events.runId, runId), eq(Schema.events.eventId, eventId))
    )
    .limit(1);
  return row !== undefined;
}

/** The event ids a single create publishes. */
export interface EventIds {
  /**
   * The id of the event this create returns. Taken on demand: a ULID-numbered
   * write mints it inside its transaction, once the row lock that orders it is
   * held.
   */
  primary: () => string;
  /**
   * An additional event written in the same breath — the synthetic
   * `step_created` of a lazy step start.
   *
   * A claim names the *top* of the pair, so this event takes the position
   * immediately below it: the caller reserved both and named one. Numbering it
   * off the log instead would hand it a position another write of the same
   * concurrent batch is already holding, and cost that write its claim.
   */
  extra: () => Promise<string>;
}

export interface PlaceEventOptions<T> {
  /**
   * Position the caller named, when it holds the log and claimed one. A claim
   * asserts the log is complete up to that position, so losing it is a conflict
   * the caller has to resolve rather than something to retry here.
   */
  claimedSlot?: number;
  /** Lowest position this write may take when allocating. */
  minSlot: number;
  /**
   * Result of a probe the caller has already made, used for the first attempt
   * instead of probing again. Later rounds always re-probe: the log has
   * demonstrably moved.
   */
  seedHighestEventId?: string | undefined;
  /** The conflict raised when a claimed position turns out to be taken. */
  onClaimTaken: () => Promise<Error>;
  /** Performs the write with the ids it should publish under. */
  write: (ids: EventIds) => Promise<T>;
}

/**
 * Writes an event at the position the caller claimed, or at the next free one.
 *
 * Every round re-probes rather than incrementing a local counter: each round at
 * least one writer wins, so re-probing guarantees progress under any amount of
 * contention. `write` must leave nothing behind when it raises a unique
 * violation — the callers here either write only the event row or wrap their
 * materialization in the same transaction, so a lost round rolls back whole.
 */
export async function placeEvent<T>(
  drizzle: Drizzle,
  runId: string,
  options: PlaceEventOptions<T>
): Promise<T> {
  const deadline = Date.now() + SLOT_RETRY_BUDGET_MS;
  for (let round = 0; ; round++) {
    let cursor: number | undefined;
    /**
     * Positions for this attempt, consecutive from one probe. Deferred so a
     * claimed write with no extra event never probes at all.
     */
    const take = async (): Promise<number> => {
      if (cursor === undefined) {
        const highest =
          round === 0 && options.seedHighestEventId !== undefined
            ? options.seedHighestEventId
            : await highestEventId(drizzle, runId);
        cursor = Math.max(
          highestSlotOf(highest) + 1,
          options.minSlot,
          // The claimed position is this write's own; an extra event must not
          // be handed it.
          (options.claimedSlot ?? 0) + 1
        );
      }
      return cursor++;
    };

    const primary =
      options.claimedSlot === undefined
        ? slotEventId(await take())
        : slotEventId(options.claimedSlot);
    /** Positions the caller named, which are the caller's to resolve. */
    const claimed = options.claimedSlot === undefined ? [] : [primary];
    try {
      return await options.write({
        primary: () => primary,
        extra: async () => {
          if (options.claimedSlot === undefined) {
            return slotEventId(await take());
          }
          const slot = options.claimedSlot - 1;
          if (slot <= FIRST_SLOT) {
            // The run's own `run_created` holds the first slot, so a claim of
            // the second leaves nowhere for a second event to go: the caller
            // reserved one position for a write that publishes two.
            throw new WorkflowWorldError(
              `Event id "${primary}" leaves no slot below it in run "${runId}" for the second event published alongside it`,
              { status: 400 }
            );
          }
          const id = slotEventId(slot);
          claimed.push(id);
          return id;
        },
      });
    } catch (error) {
      if (!isEventKeyViolation(error)) {
        throw error;
      }
      // Only a position the caller named is the caller's problem; one this
      // world allocated is reallocated below without ever surfacing.
      for (const id of claimed) {
        if (await eventExists(drizzle, runId, id)) {
          throw await options.onClaimTaken();
        }
      }
      if (Date.now() >= deadline) {
        throw new WorkflowWorldError(
          `Could not place an event in run "${runId}" within ${SLOT_RETRY_BUDGET_MS}ms of contention`,
          { status: 503 }
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, slotRetryDelay(round))
      );
    }
  }
}
