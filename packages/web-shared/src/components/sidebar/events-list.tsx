'use client';

import { EVENT_DATA_REF_FIELDS, type Event } from '@workflow/world';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hasEncryptedFields, isExpiredMarker } from '../../lib/hydration';
import { RunClickContext, StreamClickContext } from '../ui/data-inspector';
import { ErrorCard } from '../ui/error-card';
import { ErrorStackBlock, isStructuredError } from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';
import { AttrSetEventBlock } from './attributes-block';
import { CopyableDataBlock, EncryptedDataBlock } from './copyable-data-block';
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
  'attr_set',
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
  /** Mirrors whether we have a fetched payload; avoids stale `loadedData` in load closure. */
  const loadedDataRef = useRef<unknown | null>(null);

  // Check if the event already has eventData from the store
  const existingData =
    'eventData' in event && event.eventData != null ? event.eventData : null;
  const mergedDisplay = loadedData ?? existingData;
  const canHaveData = DATA_EVENT_TYPES.has(event.eventType);

  const loadEventData = useCallback(
    async (options?: { force?: boolean }) => {
      if (!onLoadEventData || !event.correlationId || !event.eventId) return;
      if (!options?.force && loadedDataRef.current !== null) {
        return;
      }

      try {
        setIsLoading(true);
        setLoadError(null);
        const data = await onLoadEventData(event.correlationId, event.eventId);
        loadedDataRef.current = data;
        setLoadedData(data);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [onLoadEventData, event.correlationId, event.eventId]
  );

  const handleExpand = useCallback(async () => {
    if (isLoading) return;
    wasExpandedRef.current = true;
    await loadEventData();
  }, [isLoading, loadEventData]);

  // When the encryption key changes and this event was previously expanded,
  // re-load the data so it gets decrypted
  useLayoutEffect(() => {
    if (!encryptionKey || !wasExpandedRef.current) return;
    loadedDataRef.current = null;
    setLoadedData(null);
    void loadEventData({ force: true });
  }, [encryptionKey, loadEventData]);

  const createdAt = new Date(event.createdAt);
  const createdAtTime = createdAt.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });

  const displayPayload = isLoading ? loadedData : mergedDisplay;

  return (
    <DetailCard
      variant="card"
      summaryClassName="px-3 py-2"
      summary={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-gray-1000 text-label-12 font-mono">
            {event.eventType}
          </span>
          <span className="shrink-0 text-label-13 text-gray-900">
            {createdAtTime}
          </span>
        </div>
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
      <div className="flex flex-col bg-background-200 [&:has(+_*)]:border-b [&:has(+_*)]:border-gray-alpha-400">
        <div className="flex items-center justify-between gap-2 py-2 px-3">
          <span className="text-label-12 text-gray-900">Event ID</span>
          <span className="max-w-[70%] truncate text-right text-label-12 font-mono">
            {event.eventId}
          </span>
        </div>
        {event.correlationId && (
          <div className="flex items-center justify-between gap-2 py-2 px-3">
            <span className="text-label-12 text-gray-900">Correlation ID</span>
            <span className="max-w-[70%] truncate text-right text-label-12 font-mono">
              {event.correlationId}
            </span>
          </div>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="p-3">
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
      {displayPayload != null && (
        <div className="[&>div]:border-none [&>div]:rounded-none">
          <EventDataBlock eventType={event.eventType} data={displayPayload} />
        </div>
      )}
    </DetailCard>
  );
}

/**
 * Check if an eventData object has only expired marker values in ref/payload
 * fields for this event type (see {@link EVENT_DATA_REF_FIELDS}). Other keys
 * (e.g. `resumeAt`, `stepName`) are ignored.
 */
function hasOnlyExpiredFields(data: unknown, eventType: string): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const refKeys = EVENT_DATA_REF_FIELDS[eventType] ?? [];
  const presentKeys = refKeys.filter((k) => k in record);
  return (
    presentKeys.length > 0 &&
    presentKeys.every((k) => isExpiredMarker(record[k]))
  );
}

/**
 * Renders event data, using ErrorStackBlock for error events that contain a
 * structured error, and CopyableDataBlock otherwise.
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
  if (isExpiredMarker(data) || hasOnlyExpiredFields(data, eventType)) {
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

  if (hasEncryptedFields({ eventType, eventData: data })) {
    return <EncryptedDataBlock />;
  }

  // Attribute changes — render the changed keys and the writer instead of
  // the raw JSON payload.
  if (eventType === 'attr_set') {
    return <AttrSetEventBlock data={data} />;
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
    if (isStructuredError(record.error)) {
      return <ErrorStackBlock value={record.error} />;
    }

    // Some error formats put the message/stack at the top level of eventData.
    if (isStructuredError(record)) {
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
  onStreamClick,
  onRunClick,
  encryptionKey,
}: {
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
  onStreamClick?: (streamId: string) => void;
  onRunClick?: (runId: string) => void;
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

  const hasEvents = sortedEvents.length > 0 && !error;

  if (!hasEvents && !isLoading) {
    return <DetailCard summary="Events" disabled />;
  }

  return (
    <RunClickContext.Provider value={onRunClick}>
      <StreamClickContext.Provider value={onStreamClick}>
        <DetailCard summary="Events" contentClassName="mb-0" defaultOpen>
          {isLoading ? (
            <div className="flex flex-col -mx-4">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 bg-background-200 px-4 py-2"
                >
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-3 w-16 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col -mx-4">
              {sortedEvents.map((event) => (
                <EventItem
                  key={event.eventId}
                  event={event}
                  onLoadEventData={onLoadEventData}
                  encryptionKey={encryptionKey}
                />
              ))}
            </div>
          )}
        </DetailCard>
      </StreamClickContext.Provider>
    </RunClickContext.Provider>
  );
}
