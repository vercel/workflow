'use client';

import { AlertCircle } from 'lucide-react';
import { useCallback } from 'react';
import useSWR from 'swr';
import {
  type EnvMap,
  fetchEventsByCorrelationId,
} from '../api/workflow-server-actions';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import type { SpanEvent } from '../trace-viewer/types';
import { convertEventsToSpanEvents } from '../workflow-traces/trace-span-construction';
import { AttributeBlock } from './attribute-panel';
import { DetailCard } from './detail-card';

export function EventsList({
  correlationId,
  env,
  events,
  expiredAt,
}: {
  correlationId: string;
  env: EnvMap;
  events: SpanEvent[];
  expiredAt?: string | Date;
}) {
  const hasExpired = expiredAt != null && new Date(expiredAt) < new Date();
  const fetchEvents = useCallback(() => {
    return fetchEventsByCorrelationId(env, correlationId, {
      sortOrder: 'asc',
      limit: 100,
      withData: !hasExpired,
    }).then((evts) => {
      if (!evts.success) {
        throw new Error(evts.error?.message || 'Failed to fetch events');
      }
      return convertEventsToSpanEvents(evts.data.data || [], false);
    });
  }, [env, correlationId, hasExpired]);

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

  const displayData = (data?.length ? data : events) || [];

  return (
    <div className="mt-2" style={{ color: 'var(--ds-gray-1000)' }}>
      <h3
        className="text-heading-16 font-medium mt-4 mb-2"
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        Events {!eventsLoading && `(${displayData.length})`}
      </h3>
      {/* Events section */}
      {eventError ? (
        <Alert variant="destructive" className="my-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load event data</AlertTitle>
          <AlertDescription className="text-sm">
            {eventError.message}
          </AlertDescription>
        </Alert>
      ) : null}
      {eventsLoading ? <div>Loading events...</div> : null}
      {!eventsLoading && !eventError && displayData.length === 0 && (
        <div className="text-sm">No events found</div>
      )}
      {displayData.length > 0 && !eventError ? (
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
              {/* Bordered container with separator */}
              <div
                className="flex flex-col divide-y rounded-md border overflow-hidden"
                style={{
                  borderColor: 'var(--ds-gray-300)',
                  backgroundColor: 'var(--ds-gray-100)',
                }}
              >
                {Object.entries(event.attributes)
                  .filter(([key]) => key !== 'eventData')
                  .map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between px-2.5 py-1.5"
                      style={{ borderColor: 'var(--ds-gray-300)' }}
                    >
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--ds-gray-500)' }}
                      >
                        {key}
                      </span>
                      <span
                        className="text-[11px] font-mono"
                        style={{ color: 'var(--ds-gray-1000)' }}
                      >
                        {String(value)}
                      </span>
                    </div>
                  ))}
              </div>
              {/* Event data section */}
              {eventError && (
                <div className="text-xs text-red-500 mt-2">
                  Error loading event data
                </div>
              )}
              {!eventError && !eventsLoading && event.attributes.eventData && (
                <div className="mt-2">
                  <AttributeBlock
                    isLoading={eventsLoading}
                    attribute="eventData"
                    value={event.attributes.eventData}
                  />
                </div>
              )}
            </DetailCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}
