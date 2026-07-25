import type { Event } from '@workflow/world';

/**
 * Appends each event whose `eventId` is not already represented in `target`.
 *
 * Existing entries are left untouched; newly appended entries retain their
 * source order and object identity. If `knownTargetIds` is provided, it must
 * contain the IDs already present in `target`; it is updated as events are
 * appended so callers can efficiently merge multiple pages.
 */
export function appendUniqueEvents(
  target: Event[],
  events: readonly Event[],
  knownTargetIds?: Set<string>
): void {
  const targetIds =
    knownTargetIds ?? new Set(target.map((event) => event.eventId));
  for (const event of events) {
    if (!targetIds.has(event.eventId)) {
      targetIds.add(event.eventId);
      target.push(event);
    }
  }
}
