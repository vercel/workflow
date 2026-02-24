'use client';

import type { Event } from '@workflow/world';
import { useCallback, useMemo, useState } from 'react';
import { Skeleton } from '../ui/skeleton';
import { localMillisecondTime } from './attribute-panel';
import { CopyableDataBlock } from './copyable-data-block';
import { DetailCard } from './detail-card';

/**
 * Event types that carry user-serialized data in their eventData field.
 */
const DATA_EVENT_TYPES = new Set([
  'step_created',
  'step_completed',
  'step_failed',
  'hook_created',
  'hook_received',
  'run_created',
  'run_completed',
]);

/**
 * A single event row that can lazy-load its eventData when expanded.
 */
function EventItem({
  event,
  onLoadEventData,
}: {
  event: Event;
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
}) {
  const [loadedData, setLoadedData] = useState<unknown | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Check if the event already has eventData from the store
  const existingData =
    'eventData' in event && event.eventData != null ? event.eventData : null;
  const displayData = existingData ?? loadedData;
  const canHaveData = DATA_EVENT_TYPES.has(event.eventType);

  const handleExpand = useCallback(async () => {
    if (existingData || loadedData !== null || isLoading) return;
    if (!onLoadEventData || !event.correlationId || !event.eventId) return;

    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await onLoadEventData(event.correlationId, event.eventId);
      setLoadedData(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [
    existingData,
    loadedData,
    isLoading,
    onLoadEventData,
    event.correlationId,
    event.eventId,
  ]);

  const createdAt = new Date(event.createdAt);

  return (
    <DetailCard
      summaryClassName="text-base py-2"
      summary={
        <>
          <span
            className="font-medium"
            style={{ color: 'var(--ds-gray-1000)' }}
          >
            {event.eventType}
          </span>{' '}
          -{' '}
          <span style={{ color: 'var(--ds-gray-700)' }}>
            {localMillisecondTime(createdAt.getTime())}
          </span>
        </>
      }
      onToggle={
        canHaveData
          ? (open) => {
              if (open) handleExpand();
            }
          : undefined
      }
    >
      {/* Event attributes */}
      <div
        className="flex flex-col divide-y rounded-md border overflow-hidden"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
        }}
      >
        <div
          className="flex min-h-[32px] items-center justify-between gap-4 px-2.5 py-1.5"
          style={{ borderColor: 'var(--ds-gray-300)' }}
        >
          <span className="text-[14px]" style={{ color: 'var(--ds-gray-700)' }}>
            eventId
          </span>
          <span
            className="max-w-[70%] truncate text-right text-[13px] font-mono"
            style={{ color: 'var(--ds-gray-1000)' }}
            title={event.eventId}
          >
            {event.eventId}
          </span>
        </div>
        {event.correlationId && (
          <div
            className="flex min-h-[32px] items-center justify-between gap-4 px-2.5 py-1.5"
            style={{ borderColor: 'var(--ds-gray-300)' }}
          >
            <span
              className="text-[14px]"
              style={{ color: 'var(--ds-gray-700)' }}
            >
              correlationId
            </span>
            <span
              className="max-w-[70%] truncate text-right text-[13px] font-mono"
              style={{ color: 'var(--ds-gray-1000)' }}
              title={event.correlationId}
            >
              {event.correlationId}
            </span>
          </div>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div
          className="mt-2 rounded-md border p-3"
          style={{
            borderColor: 'var(--ds-gray-300)',
          }}
        >
          <Skeleton className="h-4 w-[35%]" />
          <Skeleton className="mt-2 h-4 w-[90%]" />
          <Skeleton className="mt-2 h-4 w-[75%]" />
        </div>
      )}

      {/* Error state */}
      {loadError && (
        <div
          className="mt-2 rounded-md border p-2 text-sm"
          style={{
            borderColor: 'var(--ds-red-300)',
            color: 'var(--ds-red-700)',
          }}
        >
          {loadError}
        </div>
      )}

      {/* Event data */}
      {displayData != null && (
        <div className="mt-2">
          <CopyableDataBlock data={displayData} />
        </div>
      )}
    </DetailCard>
  );
}

export function EventsList({
  events,
  isLoading = false,
  error,
  onLoadEventData,
}: {
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
}) {
  // Sort by createdAt
  const sortedEvents = useMemo(
    () =>
      [...events].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ),
    [events]
  );

  return (
    <div className="mt-2" style={{ color: 'var(--ds-gray-1000)' }}>
      <h3
        className="text-heading-16 font-medium mt-4 mb-2"
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        Events {!isLoading && `(${sortedEvents.length})`}
      </h3>
      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[48px] w-full rounded-lg border" />
          <Skeleton className="h-[48px] w-full rounded-lg border" />
          <Skeleton className="h-[48px] w-full rounded-lg border" />
        </div>
      ) : null}
      {!isLoading && !error && sortedEvents.length === 0 && (
        <div className="text-sm">No events found</div>
      )}
      {sortedEvents.length > 0 && !error ? (
        <div className="flex flex-col gap-4">
          {sortedEvents.map((event) => (
            <EventItem
              key={event.eventId}
              event={event}
              onLoadEventData={onLoadEventData}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
