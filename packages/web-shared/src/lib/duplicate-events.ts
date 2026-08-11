import {
  type EntityEventClass,
  type Event,
  entityEventClass,
} from '@workflow/world';

/**
 * Copy shown on an event the runtime passed over as a repeat.
 */
export const DUPLICATE_EVENT_MESSAGE =
  'Multiple processes resuming may result in duplicate events. This event was ignored and had no effect.';

/**
 * Event classes a run records at most once per entity. A second event of one
 * of these classes for the same entity is a repeat: the first one is what the
 * replay acted on, and the runtime passes over the rest.
 *
 * `step_started` and `step_retrying` are the two classes deliberately left
 * out. A retried step records one of each per attempt, and the runtime
 * consumes them, so a repeat there is an extra attempt rather than an ignored
 * event.
 */
const ONCE_PER_ENTITY_CLASSES: ReadonlySet<EntityEventClass> = new Set([
  'step_created',
  'step_terminal',
  'wait_created',
  'wait_completed',
  'hook_created',
  'hook_disposed',
  'run_started',
  'run_terminal',
]);

function entityKey(event: Event): string | undefined {
  const eventClass = entityEventClass(event.eventType);
  if (eventClass === undefined || !ONCE_PER_ENTITY_CLASSES.has(eventClass)) {
    return undefined;
  }
  // Run events carry no correlation id, so they key on the class alone.
  return `${eventClass}:${event.correlationId ?? ''}`;
}

function effectiveTime(event: Event): number {
  const occurredAt = event.occurredAt;
  if (occurredAt != null) {
    const parsed =
      occurredAt instanceof Date ? occurredAt : new Date(String(occurredAt));
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  }
  return new Date(event.createdAt).getTime();
}

/**
 * Event ids that repeat a class the log already records for the same entity.
 *
 * Concurrent replays of one run share an event log, so a replay working from
 * a stale prefix can commit a write the log already has. The runtime passes
 * over those (see `EventsConsumer` in `@workflow/core`); this reports them so
 * the UI can say so rather than showing them as ordinary progress.
 *
 * Order is decided here, not by the caller: the earliest event of a class is
 * the one that counted, whichever direction the view happens to sort in. The
 * answer is exact only over a complete event list. A partial list (pagination,
 * an exact-id search) can miss a repeat whose first occurrence is absent,
 * which under-reports rather than mislabels.
 */
export function findDuplicateEventIds(events: readonly Event[]): Set<string> {
  const duplicates = new Set<string>();
  if (events.length < 2) return duplicates;

  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        effectiveTime(a.event) - effectiveTime(b.event) || a.index - b.index
    );

  const seen = new Set<string>();
  for (const { event } of ordered) {
    const key = entityKey(event);
    if (key === undefined) continue;
    if (seen.has(key)) {
      duplicates.add(event.eventId);
      continue;
    }
    seen.add(key);
  }
  return duplicates;
}
