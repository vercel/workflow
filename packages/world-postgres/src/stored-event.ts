import { type Event, EventSchema, EventTypeSchema } from '@workflow/world';
import { and, inArray, isNotNull } from 'drizzle-orm';
import * as z from 'zod';
import { type DrizzleHandle, Schema } from './drizzle/index.js';
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

type StoredEventParse =
  | { ok: true; event: Event }
  | { ok: false; row: EventRow; error: z.ZodError };

function parseRow(row: EventRow): StoredEventParse {
  const value = compact({
    ...row,
    eventData: row.eventData ?? row.eventDataJson,
  });
  const parsed = EventSchema.safeParse(value);
  if (parsed.success) return { ok: true, event: parsed.data };
  if (value.eventData !== undefined) throw parsed.error;
  return { ok: false, row, error: parsed.error };
}

function purgedEvent(row: EventRow): Event {
  return PurgedEventSchema.parse(
    compact({ ...row, eventData: undefined, eventDataJson: undefined })
  ) as Event;
}

/**
 * Parse event rows read from `workflow_events`, in order.
 *
 * Deleting a finished run's data (`purgeRunUserData` in `./retention.ts`, on
 * zero retention or on demand through `runs.deleteDataMany`) clears
 * `payload_cbor` and `payload` on every event of the run and stamps the run's
 * `expired_at`; `scrubStepWriteIfRunPurged` does the same for a step event
 * written after it. Most event types require an `eventData` object. An event
 * of a run with `expired_at` set is therefore returned without its
 * `eventData`, the way `stripEventDataRefs` returns one whose `eventData` held
 * nothing but payloads, so a purged run's log still lists.
 *
 * Nothing else clears an event's data, so a row whose type requires
 * `eventData` and has none, on a run whose data was not deleted, is corrupt:
 * it throws the parse error, as does a row whose `eventData` does not parse.
 * Only rows without `eventData` cost a query, one for the whole batch.
 */
export async function parseStoredEvents(
  db: Pick<DrizzleHandle, 'select'>,
  rows: EventRow[]
): Promise<Event[]> {
  const results = rows.map(parseRow);
  const dataless = results.filter((r) => !r.ok);
  if (dataless.length === 0) {
    return results.map((r) => (r as { event: Event }).event);
  }
  const runIds = [...new Set(dataless.map((r) => r.row.runId))];
  const expired = new Set(
    (
      await db
        .select({ id: Schema.runs.runId })
        .from(Schema.runs)
        .where(
          and(
            inArray(Schema.runs.runId, runIds),
            isNotNull(Schema.runs.expiredAt)
          )
        )
    ).map((run) => run.id)
  );
  return results.map((r) => {
    if (r.ok) return r.event;
    if (!expired.has(r.row.runId)) throw r.error;
    return purgedEvent(r.row);
  });
}

/** {@link parseStoredEvents} for one row. */
export async function parseStoredEvent(
  db: Pick<DrizzleHandle, 'select'>,
  row: EventRow
): Promise<Event> {
  const [event] = await parseStoredEvents(db, [row]);
  return event!;
}
