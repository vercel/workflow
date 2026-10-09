import type { Event } from '@workflow/world';

/** Returns the most recent non-empty reason recorded on a run cancellation. */
export function getCancellationReason(
  events: readonly Event[] | null | undefined
): string | undefined {
  if (!events) return undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.eventType !== 'run_cancelled') continue;

    const reason = event.eventData?.cancelReason?.trim();
    if (reason) return reason;
  }

  return undefined;
}
