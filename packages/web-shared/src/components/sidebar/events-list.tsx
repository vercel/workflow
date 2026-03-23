'use client';

import type { Event } from '@workflow/world';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isExpiredMarker } from '../../lib/hydration';
import { ErrorCard } from '../ui/error-card';
import {
  ErrorStackBlock,
  isStructuredErrorWithStack,
} from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';
import { localMillisecondTime } from './attribute-panel';
import { CopyableDataBlock } from './copyable-data-block';
import { DetailCard } from './detail-card';

/**
 * Event types whose eventData contains an error field with a StructuredError.
 */
const ERROR_EVENT_TYPES = new Set(['step_failed', 'step_retrying']);

/**
 * Event types that carry user-serialized data in their eventData field.
 */
const DATA_EVENT_TYPES = new Set([
  'step_created',
  'step_completed',
  'step_failed',
  'step_retrying',
  'hook_created',
  'hook_received',
  'run_created',
  'run_completed',
  'run_failed',
  'wait_created',
  'wait_completed',
]);

/**
 * A single event row that can lazy-load its eventData when expanded.
 */
function EventItem({
  event,
  onLoadEventData,
  encryptionKey,
}: {
  event: Event;
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
  /** When this changes (e.g., Decrypt was clicked), invalidate cached data */
  encryptionKey?: Uint8Array;
}) {
  const [loadedData, setLoadedData] = useState<unknown | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const wasExpandedRef = useRef(false);

  // Check if the event already has eventData from the store
  const existingData =
    'eventData' in event && event.eventData != null ? event.eventData : null;
  const displayData = existingData ?? loadedData;
  const canHaveData = DATA_EVENT_TYPES.has(event.eventType);

  const loadEventData = useCallback(async () => {
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
  }, [onLoadEventData, event.correlationId, event.eventId]);

  const handleExpand = useCallback(async () => {
    if (existingData || loadedData !== null || isLoading) return;
    wasExpandedRef.current = true;
    await loadEventData();
  }, [existingData, loadedData, isLoading, loadEventData]);

  // When the encryption key changes and this event was previously expanded,
  // re-load the data so it gets decrypted
  useEffect(() => {
    if (encryptionKey && wasExpandedRef.current && loadedData !== null) {
      setLoadedData(null); // clear stale data
      loadEventData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey]);

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
        <ErrorCard
          title="Failed to load event data"
          details={loadError}
          className="mt-2"
        />
      )}

      {/* Event data */}
      {displayData != null && (
        <div className="mt-2">
          <EventDataBlock eventType={event.eventType} data={displayData} />
        </div>
      )}
    </DetailCard>
  );
}

/**
 * Check if an eventData object has only expired marker values in its serialized
 * sub-fields (result, input, output, metadata, payload). Non-serialized fields
 * like `resumeAt` or `reason` are ignored.
 */
function hasOnlyExpiredFields(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const serializedKeys = ['result', 'input', 'output', 'metadata', 'payload'];
  const presentKeys = serializedKeys.filter((k) => k in record);
  return (
    presentKeys.length > 0 &&
    presentKeys.every((k) => isExpiredMarker(record[k]))
  );
}

/**
 * Renders event data, using ErrorStackBlock for error events that contain
 * a structured error with a stack trace, and CopyableDataBlock otherwise.
 */
function EventDataBlock({
  eventType,
  data,
}: {
  eventType: string;
  data: unknown;
}) {
  // Expired data — show a simple message instead of the raw stub.
  // Check both the top-level eventData and nested sub-fields (result, input, etc.)
  // since the server stubs each ref field independently.
  if (isExpiredMarker(data) || hasOnlyExpiredFields(data)) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-700)',
        }}
      >
        <span className="font-medium">Data expired</span>
      </div>
    );
  }

  // For error events (step_failed, step_retrying), the eventData has the shape
  // { error: StructuredError, stack?: string, ... }. Check both the top-level
  // value and the nested `error` field for a stack trace.
  if (
    ERROR_EVENT_TYPES.has(eventType) &&
    data != null &&
    typeof data === 'object'
  ) {
    const record = data as Record<string, unknown>;

    // Check the nested `error` field first (the StructuredError)
    if (isStructuredErrorWithStack(record.error)) {
      return <ErrorStackBlock value={record.error} />;
    }

    // Some error formats put the stack at the top level of eventData
    if (isStructuredErrorWithStack(record)) {
      return <ErrorStackBlock value={record} />;
    }
  }

  // For non-error events or errors without a stack, fall back to the
  // generic JSON viewer.
  return <CopyableDataBlock data={data} />;
}

export function EventsList({
  events,
  isLoading = false,
  error,
  onLoadEventData,
  encryptionKey,
}: {
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
  /** When provided, signals that decryption is active (triggers re-load of expanded events) */
  encryptionKey?: Uint8Array;
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
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
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
              encryptionKey={encryptionKey}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
