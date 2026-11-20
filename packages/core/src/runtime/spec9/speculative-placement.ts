import { type Event, eventIdToSlot } from '@workflow/world';

/**
 * Where run-ahead's speculative events sit in a delivery's log, and what
 * happens when a committed event turns up at one of their slots.
 *
 * A speculative event is placed in the log at the slot its write is expected
 * to take, before the write commits (see "Where a speculative event is
 * placed" in `./README.md`). The log keeps one event per id, and the workflow
 * consumes it in slot order, so the rules here are what keeps a wrong
 * placement from dropping an event or reordering two outcomes. They are pure
 * functions of what the delivery holds, so each is tested by itself
 * (`speculative-placement.test.ts`); `delivery.ts` supplies the state.
 */

/** The speculative event the log holds unconfirmed under an event id, if any. */
export type SpeculativeEventAt = (eventId: string) => Event | undefined;

/**
 * Whether a speculative event and a committed one are the same write: its
 * commit, or the live feed's echo of it.
 */
function isSameWrite(speculative: Event, committed: Event): boolean {
  return (
    speculative.eventType === committed.eventType &&
    speculative.correlationId === committed.correlationId
  );
}

/**
 * The slot the next speculative write is placed at: the writer's prediction,
 * and never at or below a slot the log already holds or an unconfirmed
 * speculative write was placed at. Two events must not share an id (the log
 * would drop the second), and speculative events must sit in the order their
 * writes were queued, which is the order they commit in and the order the
 * workflow consumed them. When the prediction is exact this changes nothing.
 */
export function speculativeSlotFor(input: {
  /** `InBandWriter.predictNextSlot()`. */
  predicted: number;
  /** The highest slot the log holds, speculative events included. */
  heldMaxSlot: number | undefined;
  /** Slots of the speculative writes still in flight. */
  unconfirmedSlots: Iterable<number>;
}): number {
  let floor = input.heldMaxSlot ?? 0;
  for (const slot of input.unconfirmedSlots) {
    if (slot > floor) floor = slot;
  }
  return Math.max(input.predicted, floor + 1);
}

/**
 * Whether `event` committed at a slot the log holds another event's
 * speculative copy at. That copy was placed at the wrong slot, so the log's
 * order is no longer the run's, and folding `event` in would drop it.
 */
export function displacesSpeculation(
  event: Event,
  speculativeAt: SpeculativeEventAt
): boolean {
  const speculative = speculativeAt(event.eventId);
  return speculative !== undefined && !isSameWrite(speculative, event);
}

/**
 * What events read outside this delivery's own answers (the live feed, an
 * incremental load) mean for a log that holds speculative events:
 *
 * - an event at a slot with no speculative copy is folded in;
 * - a speculative write's own commit, read before its answer, is left out:
 *   the speculative copy stands until the answer confirms or repairs it;
 * - an event at a slot another event's speculative copy holds was displaced
 *   by a wrong placement. It is left out too (the log would drop it), and a
 *   repair is due, which rebuilds the log from what committed.
 */
export function foldReadEvents(
  events: readonly Event[],
  speculativeAt: SpeculativeEventAt
): { fold: Event[]; displaced: boolean } {
  const fold: Event[] = [];
  let displaced = false;
  for (const event of events) {
    const speculative = speculativeAt(event.eventId);
    if (speculative === undefined) {
      fold.push(event);
    } else if (!isSameWrite(speculative, event)) {
      displaced = true;
    }
  }
  return { fold, displaced };
}

/**
 * How the outcome of an inline step that settled joins the log:
 *
 * - `fold`: an outcome on the awaited path, or one written ahead whose write
 *   is still unconfirmed and whose slot is free. It is merged.
 * - `committed`: written ahead, and its write settled before the body did.
 *   The committed event reached the log with the write's answer, or a repair
 *   rebuilt the log from it. The speculative copy still carries the slot it
 *   was predicted at, which may be another event's by now, so it is not
 *   merged.
 * - `displaced`: written ahead and unconfirmed, but its slot is taken. Its
 *   write commits elsewhere, and a repair is due.
 */
export function settledOutcomeFold(input: {
  /** The outcome's event is a speculative copy (`writeOutcomeAhead`). */
  writtenAhead: boolean;
  /** Its write has not settled. */
  unconfirmed: boolean;
  /** The log already holds an event under its id. */
  slotHeld: boolean;
}): 'fold' | 'committed' | 'displaced' {
  if (!input.writtenAhead) return 'fold';
  if (!input.unconfirmed) return 'committed';
  return input.slotHeld ? 'displaced' : 'fold';
}

/**
 * Whether a repair found a speculative write committed below the slot it was
 * placed at (`aliases` maps each displaced event's predicted id to the id it
 * committed under). A rebase of the retained session covers events shifted
 * up, by what another writer placed below them. One that committed lower was
 * placed past the position it took, and the session replays from cold.
 */
export function committedBelowPrediction(
  aliases: Iterable<readonly [predicted: string, committed: string]>
): boolean {
  for (const [predicted, committed] of aliases) {
    const predictedSlot = eventIdToSlot(predicted);
    const committedSlot = eventIdToSlot(committed);
    if (
      predictedSlot !== null &&
      committedSlot !== null &&
      committedSlot < predictedSlot
    ) {
      return true;
    }
  }
  return false;
}
