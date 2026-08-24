import {
  type EntityEventClass,
  type Event,
  entityEventClass,
  isSlotEventId,
} from '@workflow/world';

/**
 * Identifies events a replay reads past.
 *
 * Concurrent replays of one run write to a shared log, so a replay working
 * from a stale prefix can commit a second `step_created` / `step_started` /
 * `wait_created` for an entity the log already records one of. Every replay
 * reads the first event of that class at the same position, so a later one
 * cannot change what the workflow observes.
 *
 * The classification mirrors `entityEventClass` in `@workflow/world`, which is
 * what the runtime keys its own duplicate detection on. What it cannot mirror
 * is consumer state: the runtime passes over an event only after every
 * registered callback has declined it, and a callback registered for a
 * still-open entity legitimately claims a repeat (each retry of a step writes
 * another `step_started`, and a live step consumer absorbs a second
 * `step_created`). So a repeat counts here only once a terminal event for the
 * same entity sits earlier in the log, which is the point past which no
 * consumer remains.
 */

/**
 * Classes whose event closes its entity: no consumer is left for it after.
 *
 * The run's own terminal events are absent because `entityEventClass` gives
 * them no class. The runtime exits rather than replaying the body once the log
 * holds one, so nothing ever consumes them and nothing can repeat them.
 */
const TERMINAL_EVENT_CLASSES: ReadonlySet<EntityEventClass> = new Set([
  'step_terminal',
  'wait_completed',
  'hook_disposed',
]);

/** Classes with no entity to close first: the log records one per run. */
const SINGLETON_EVENT_CLASSES: ReadonlySet<EntityEventClass> = new Set([
  'run_started',
]);

/** Entity key for events that carry no correlation ID (the run itself). */
const RUN_ENTITY_KEY = '';

/**
 * Shown against an event this module reports. Deliberately says what the log
 * shows rather than what the runtime did with it: tolerating these repeats is
 * recent, and on a run recorded before it a repeat no consumer claimed failed
 * the replay instead of being passed over.
 */
export const DUPLICATE_EVENT_MESSAGE =
  'Written by a concurrent replay after an event of the same kind was already recorded and acted on. The run follows the earlier one.';

/**
 * Candidate log order, by event ID.
 *
 * Event IDs are fixed-width and monotonic within a run under both the ULID and
 * the slot scheme. Length is compared first so a shorter ID never sorts after
 * a longer one on a log that mixes widths.
 *
 * Whether this *is* the log order depends on the ID scheme, which is why
 * {@link hasKnowableLogOrder} gates the fold. See its doc.
 */
function compareEventId(a: Event, b: Event): number {
  if (a.eventId.length !== b.eventId.length) {
    return a.eventId.length - b.eventId.length;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function createdAtMs(event: Event): number {
  const createdAt = event.createdAt;
  return createdAt instanceof Date
    ? createdAt.getTime()
    : new Date(createdAt as unknown as string).getTime();
}

/**
 * Whether the order the run consumed its log in can be recovered from the
 * events alone.
 *
 * Which occurrence of a class came first is the whole question here, so the
 * fold needs the log's order, not an order. The backends do not agree on how
 * to recover it for every ID scheme:
 *
 * - A **slot-numbered** run carries its position in the ID. The slot is drawn
 *   at the publish, which is the linearization point, so slot order is log
 *   order everywhere and the ID alone settles it.
 * - A **ULID-numbered** run does not. One backend returns such a log in
 *   `(createdAt, eventId)` order while another returns it keyed on the ID, and
 *   `createdAt` is stamped when the write request arrives rather than when it
 *   commits. Concurrent writers can therefore produce opposite timestamp and
 *   ID orders, and the run consumed whichever its own backend served.
 *
 * So a ULID log is only knowable where the two orders agree. Where they
 * contradict, the fold could name the surviving event and pass over the one
 * the run acted on, which is worse than saying nothing.
 */
function hasKnowableLogOrder(orderedById: readonly Event[]): boolean {
  if (orderedById.every((event) => isSlotEventId(event.eventId))) return true;

  for (let index = 1; index < orderedById.length; index++) {
    const previous = createdAtMs(orderedById[index - 1]);
    const current = createdAtMs(orderedById[index]);
    // A missing or unparseable timestamp leaves nothing to corroborate the ID
    // order with, which is the same position as a contradiction.
    if (Number.isNaN(previous) || Number.isNaN(current)) return false;
    if (current < previous) return false;
  }

  return true;
}

/** The fold itself, over a log whose order is known. */
function foldDuplicates(ordered: readonly Event[]): Set<string> {
  const duplicates = new Set<string>();
  const seenClasses = new Set<string>();
  const closedEntities = new Set<string>();

  for (const event of ordered) {
    const eventClass = entityEventClass(event.eventType);
    if (eventClass === undefined) continue;

    const entity = event.correlationId ?? RUN_ENTITY_KEY;
    const classKey = `${eventClass}:${entity}`;
    const repeatsClass = seenClasses.has(classKey);
    const entityWasClosed = closedEntities.has(entity);

    if (TERMINAL_EVENT_CLASSES.has(eventClass)) {
      closedEntities.add(entity);
    }

    if (!repeatsClass) {
      // First of its class, but the entity already finished: no consumer is
      // left to take it and it repeats nothing, so the runtime reports
      // divergence here and exits. Everything past this point went unread, so
      // the fold stops with it rather than recording the class and presenting
      // a later event of it as a repeat the run passed over.
      if (entityWasClosed) break;
      seenClasses.add(classKey);
      continue;
    }

    // The entity is still open, so a consumer is registered for it and takes
    // this event: another attempt, not a repeat read past.
    if (entityWasClosed || SINGLETON_EVENT_CLASSES.has(eventClass)) {
      duplicates.add(event.eventId);
    }
  }

  return duplicates;
}

/**
 * The IDs of the events in `events` that repeat a class the log already
 * records for the same entity, after that entity finished.
 *
 * `isCompleteHistory` must be false whenever the caller holds a subset of the
 * run's log: one page of a paginated list, or the result of a search. Which
 * occurrence of a class came first is a property of the whole log, so on a
 * subset the earlier event may be missing, and the fold would report
 * the surviving one. Nothing is classified in that case.
 *
 * Two other things make the answer unknowable and yield the same empty result:
 * a log whose order cannot be recovered from the events (see
 * {@link hasKnowableLogOrder}), and everything past the point the run
 * diverged, since the run exited there and read no further.
 */
export function findDuplicateEventIds(
  events: readonly Event[],
  { isCompleteHistory }: { isCompleteHistory: boolean }
): Set<string> {
  if (!isCompleteHistory || events.length < 2) return new Set();

  // Dropped before the sort, not during the fold: an event with no ID has no
  // log position to order on, and the caller could not match it either.
  const ordered = events
    .filter((event) => Boolean(event.eventId))
    .sort(compareEventId);

  if (!hasKnowableLogOrder(ordered)) return new Set();

  return foldDuplicates(ordered);
}
