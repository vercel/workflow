/**
 * Shared event-decoding helper.
 *
 * Lives in its own module because both `events.ts` (which owns the public
 * event functions) and `events-v4.ts` (the wire-level client, imported *by*
 * `events.ts`) need it — putting it in `events.ts` would make that import
 * circular.
 */

import { type Event, EventSchema, EventTypeSchema } from '@workflow/world';

/**
 * Run an assembled event through EventSchema so per-event-type
 * z.coerce.date() (wait_created.resumeAt, wait_completed.resumeAt,
 * step_retrying.retryAfter) converts the ISO strings the backing store
 * returns back into Date instances — the workflow runtime calls .getTime() on
 * these and would otherwise crash. safeParse: pass the event through
 * unchanged if it doesn't match a known shape (legacy / mid-rollout).
 *
 * Used by every path that hands events to the runtime: GET/LIST frames
 * (via buildEventFromV4), the POST response's `event` / preloaded `events`
 * bag, and the events a rejecting backend attaches to a 412 — all of these
 * can carry events read back from the backing store, where nested eventData
 * dates are stored as ISO strings.
 */
export function coerceEventDates(raw: Record<string, unknown>): Event {
  const parsed = EventSchema.safeParse(raw);
  if (parsed.success) return parsed.data as unknown as Event;
  if (EventTypeSchema.safeParse(raw.eventType).success) {
    // The raw-event fallback is for unknown/future event types. A parse
    // failure on a *known* type means a schema/coercion regression that
    // would otherwise only surface later as a crash deep in the runtime
    // (e.g. .getTime() on a resumeAt that stayed a string) — leave a
    // breadcrumb at the actual failure point.
    console.debug(
      `[workflow:world-vercel] v4 event ${raw.eventId} failed ` +
        `EventSchema parse for known eventType '${raw.eventType}'; ` +
        `passing through unparsed: ${parsed.error.message}`
    );
  }
  return raw as unknown as Event;
}
