'use client';

import type { Event } from '@workflow/world';
import { DetailMonoKeyValueRow } from '../sidebar/attributes-block';

/**
 * An event's Event ID and Correlation ID as copyable rows. Renders the rows
 * only, so each caller places them in its own container next to the rows it
 * adds, such as timestamps.
 */
export function EventIdentifiers({
  event,
}: {
  event: Pick<Event, 'eventId' | 'correlationId'>;
}) {
  return (
    <>
      <DetailMonoKeyValueRow
        label="Event ID"
        value={event.eventId}
        copyText={event.eventId}
      />
      {event.correlationId ? (
        <DetailMonoKeyValueRow
          label="Correlation ID"
          value={event.correlationId}
          copyText={event.correlationId}
        />
      ) : null}
    </>
  );
}
