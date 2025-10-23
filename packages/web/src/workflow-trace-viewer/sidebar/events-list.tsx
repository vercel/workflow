'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import {
  type EnvMap,
  fetchEventsByCorrelationId,
} from '../api/workflow-server-actions';
import type { SpanEvent } from '../trace-viewer/types';
import { convertEventsToSpanEvents } from '../workflow-traces/trace-span-construction';
import { AttributeBlock } from './attribute-panel';
import { DetailCard } from './detail-card';

export function EventsList({
  correlationId,
  env,
  events,
}: {
  correlationId: string;
  env: EnvMap;
  events: SpanEvent[];
}) {
  const fetchEvents = useCallback(() => {
    return fetchEventsByCorrelationId(env, correlationId, {
      sortOrder: 'asc',
      limit: 100,
      withData: true,
    }).then((evts) => convertEventsToSpanEvents(evts.data || [], false));
  }, [env, correlationId]);

  const {
    data,
    error: eventError,
    isLoading: eventsLoading,
  } = useSWR<SpanEvent[] | null>(
    ['workflow', 'events', correlationId],
    fetchEvents,
    {
      fallbackData: events,
      revalidateOnFocus: false,
    }
  );

  const displayData = data || events || [];

  return (
    <div className="mt-2" style={{ color: 'var(--ds-gray-1000)' }}>
      <h4>Associated Events</h4>
      {/* Events section */}
      {eventError ? (
        <div>Error loading events: {eventError.message}</div>
      ) : null}
      {eventsLoading ? <div>Loading events...</div> : null}
      {displayData.length > 0 && !eventError ? (
        <>
          <h3
            className="text-heading-16 font-medium mt-4 mb-2"
            style={{ color: 'var(--ds-gray-1000)' }}
          >
            Events ({displayData.length})
          </h3>
          <div className="flex flex-col gap-2">
            {displayData.map((event, index) => (
              <DetailCard
                key={`${event.name}-${index}`}
                summary={
                  <>
                    <span
                      className="font-medium"
                      style={{ color: 'var(--ds-gray-1000)' }}
                    >
                      {event.name}
                    </span>{' '}
                    -{' '}
                    <span style={{ color: 'var(--ds-gray-700)' }}>
                      {new Date(
                        event.timestamp[0] * 1000 + event.timestamp[1] / 1e6
                      ).toLocaleString()}
                    </span>
                  </>
                }
              >
                <div className="mt-2 px-4">
                  {Object.entries(event.attributes)
                    .filter(([key]) => key !== 'eventData')
                    .map(([key, value]) => (
                      <AttributeBlock key={key} attribute={key} value={value} />
                    ))}
                  <div className="relative">
                    {eventError && <div>Error loading event data</div>}
                    {!eventError &&
                      !eventsLoading &&
                      event.attributes.eventData && (
                        <AttributeBlock
                          isLoading={eventsLoading}
                          attribute="eventData"
                          value={event.attributes.eventData}
                        />
                      )}
                  </div>
                </div>
              </DetailCard>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
