'use client';

import { useMemo } from 'react';
import { ErrorCard } from '../ui/error-card';
import type { SpanEvent } from '../trace-viewer/types.js';
import { AttributeBlock, localMillisecondTime } from './attribute-panel';
import { DetailCard } from './detail-card';

export function EventsList({
  events,
  fullEvents,
  isLoading = false,
  error,
}: {
  events: SpanEvent[];
  fullEvents?: SpanEvent[] | null;
  isLoading?: boolean;
  error?: Error | null;
}) {
  const displayData = useMemo(
    () => (fullEvents?.length ? fullEvents : events) || [],
    [events, fullEvents]
  );

  return (
    <div className="mt-2" style={{ color: 'var(--ds-gray-1000)' }}>
      <h3
        className="text-heading-16 font-medium mt-4 mb-2"
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        Events {!isLoading && `(${displayData.length})`}
      </h3>
      {error ? (
        <ErrorCard
          title="Failed to load full event list"
          details={error?.message}
          className="my-4"
        />
      ) : null}
      {isLoading ? <div>Loading events...</div> : null}
      {!isLoading && !error && displayData.length === 0 && (
        <div className="text-sm">No events found</div>
      )}
      {displayData.length > 0 && !error ? (
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
                    {localMillisecondTime(
                      event.timestamp[0] * 1000 + event.timestamp[1] / 1e6
                    )}
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
                        style={{ color: 'var(--ds-gray-700)' }}
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
              {error ? (
                <ErrorCard
                  title="Failed to load event data"
                  details={String(error)}
                  className="my-4"
                />
              ) : null}
              {!error && !isLoading && event.attributes.eventData != null && (
                <div className="mt-2">
                  <AttributeBlock
                    isLoading={isLoading}
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
