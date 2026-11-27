import { type Event, EventSchema, EventTypeSchema } from '@workflow/world';
import * as z from 'zod';
import type { Schema } from './drizzle/index.js';
import { compact } from './util.js';

type EventRow = typeof Schema.events.$inferSelect;

/**
 * What is left of an event whose `eventData` a purge deleted: the fields every
 * event has whatever its type.
 */
const PurgedEventSchema = z.object({
  eventType: EventTypeSchema,
  correlationId: z.string().optional(),
  runId: z.string(),
  eventId: z.string(),
  createdAt: z.coerce.date(),
  specVersion: z.number().optional(),
  resumeId: z.string().optional(),
});

/**
 * Parse an event row read from `workflow_events`.
 *
 * A zero-retention purge (`purgeRunUserData` in `./retention.ts`) clears
 * `payload_cbor` and `payload` on every event of a finished run, and most
 * event types require an `eventData` object. Such an event is returned without
 * its `eventData`, the way `stripEventDataRefs` returns one whose `eventData`
 * held nothing but payloads, so a purged run's log still lists.
 *
 * An event is validated against `EventSchema` when it is written, so a stored
 * row without `eventData` whose type requires it can only be one a purge
 * emptied. A row that still has its `eventData` and does not parse is
 * reported as before.
 */
export function parseStoredEvent(row: EventRow): Event {
  const value = compact({
    ...row,
    eventData: row.eventData ?? row.eventDataJson,
  });
  const parsed = EventSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (value.eventData !== undefined) throw parsed.error;
  return PurgedEventSchema.parse(value) as Event;
}
