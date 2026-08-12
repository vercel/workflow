import {
  type EntityEventClass,
  type Event,
  entityEventClass,
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
 * Log order.
 *
 * Event IDs are fixed-width and monotonic within a run under both the ULID and
 * the slot scheme, so comparing them orders the log even where timestamps do
 * not: a writer stamps `createdAt` on entry but takes its log position at
 * publish time, and `occurredAt` is measured on the client. Length is compared
 * first so a shorter ID never sorts after a longer one on a fixture or a log
 * that mixes widths.
 */
function compareLogPosition(a: Event, b: Event): number {
  if (a.eventId.length !== b.eventId.length) {
    return a.eventId.length - b.eventId.length;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * The IDs of the events in `events` that repeat a class the log already
 * records for the same entity, after that entity finished.
 *
 * `isCompleteHistory` must be false whenever the caller holds a subset of the
 * run's log: one page of a paginated list, or the result of a search. Which
 * occurrence of a class came first is a property of the whole log, so on a
 * subset the earlier event may simply be missing, and the fold would report
 * the surviving one. Nothing is classified in that case.
 */
export function findDuplicateEventIds(
  events: readonly Event[],
  { isCompleteHistory }: { isCompleteHistory: boolean }
): Set<string> {
  const duplicates = new Set<string>();
  if (!isCompleteHistory || events.length < 2) return duplicates;

  const seenClasses = new Set<string>();
  const closedEntities = new Set<string>();

  // Dropped before the sort, not during the fold: an event with no ID has no
  // log position to order on, and the caller could not match it either.
  const ordered = events
    .filter((event) => Boolean(event.eventId))
    .sort(compareLogPosition);

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
      seenClasses.add(classKey);
      continue;
    }

    // The entity is still open, so a consumer is registered for it and takes
    // this event: another attempt, not a repeat read past.
    if (!entityWasClosed && !SINGLETON_EVENT_CLASSES.has(eventClass)) {
      continue;
    }

    duplicates.add(event.eventId);
  }

  return duplicates;
}
