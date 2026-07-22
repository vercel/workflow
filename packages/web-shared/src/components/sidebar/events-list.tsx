'use client';

import { type Event, getEventDataRefFields } from '@workflow/world';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hasEncryptedFields, isExpiredMarker } from '../../lib/hydration';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { RunClickContext, StreamClickContext } from '../ui/data-inspector';
import { ErrorCard } from '../ui/error-card';
import { ErrorStackBlock, isStructuredError } from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';
import { TimestampTooltip } from '../ui/timestamp-tooltip';
import { AttrSetEventBlock } from './attributes-block';
import { CopyableDataBlock, EncryptedDataBlock } from './copyable-data-block';

const parseDateValue = (value: unknown): Date | null => {
  if (value == null) return null;

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const getEffectiveEventDate = (
  event: Pick<Event, 'createdAt' | 'occurredAt'>
): Date => parseDateValue(event.occurredAt) ?? new Date(event.createdAt);

const formatEventTimestamp = (date: Date): string =>
  date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    fractionalSecondDigits: 3,
    timeZoneName: 'short',
  });

/**
 * A single event row that can lazy-load its eventData when expanded.
 */
function EventItem({
  event,
  onLoadEventData,
  encryptionKey,
  showSeparateEventOccurrenceTimestamps = false,
}: {
  event: Event;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  /** When this changes (e.g., Decrypt was clicked), invalidate cached data */
  encryptionKey?: Uint8Array;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
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
  const canHaveData =
    existingData !== null || getEventDataRefFields(event.eventType).length > 0;

  const loadEventData = useCallback(
    async (force: boolean) => {
      if (!onLoadEventData) return;
      if (!force && loadedDataRef.current !== null) {
        return;
      }

      try {
        setIsLoading(true);
        setLoadError(null);
        const data = await onLoadEventData(event);
        loadedDataRef.current = data;
        setLoadedData(data);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [onLoadEventData, event]
  );

  const handleExpand = useCallback(() => {
    if (isLoading) return;
    wasExpandedRef.current = true;
    void loadEventData(false);
  }, [isLoading, loadEventData]);

  // When the encryption key changes and this event was previously expanded,
  // re-load the data so it gets decrypted
  useLayoutEffect(() => {
    if (!encryptionKey || !wasExpandedRef.current) return;
    loadedDataRef.current = null;
    setLoadedData(null);
    void loadEventData(true);
  }, [encryptionKey, loadEventData]);

  const createdAt = new Date(event.createdAt);
  const occurredAt = parseDateValue(event.occurredAt);
  const displayedCreatedAt = showSeparateEventOccurrenceTimestamps
    ? createdAt
    : getEffectiveEventDate(event);
  const displayedCreatedAtTime = displayedCreatedAt.toLocaleTimeString(
    undefined,
    {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }
  );

  const displayPayload = isLoading ? loadedData : mergedDisplay;

  return (
    <CollapsibleRoot
      variant="card"
      onOpenChange={
        canHaveData
          ? (open) => {
              if (open) handleExpand();
            }
          : undefined
      }
    >
      <CollapsibleTrigger className="px-3 py-2">
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-gray-1000 text-label-12 font-mono">
            {event.eventType}
          </span>
          <span className="shrink-0 text-label-13 text-gray-900">
            {displayedCreatedAtTime}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* Event attributes */}
        <div className="flex flex-col bg-background-200 [&:has(+_*)]:border-b [&:has(+_*)]:border-gray-alpha-400">
          {showSeparateEventOccurrenceTimestamps && occurredAt && (
            <div className="flex items-center justify-between gap-2 py-2 px-3">
              <span className="text-label-12 text-gray-900">Occurred</span>
              <TimestampTooltip date={occurredAt}>
                <span className="max-w-[70%] truncate text-right text-label-12 font-mono">
                  {formatEventTimestamp(occurredAt)}
                </span>
              </TimestampTooltip>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 py-2 px-3">
            <span className="text-label-12 text-gray-900">Event ID</span>
            <span className="max-w-[70%] truncate text-right text-label-12 font-mono">
              {event.eventId}
            </span>
          </div>
          {event.correlationId && (
            <div className="flex items-center justify-between gap-2 py-2 px-3">
              <span className="text-label-12 text-gray-900">
                Correlation ID
              </span>
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
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}

/**
 * Check if an eventData object has only expired marker values in ref/payload
 * fields for this event type (see {@link getEventDataRefFields}). Other keys
 * (e.g. `resumeAt`, `stepName`) are ignored.
 */
function hasOnlyExpiredFields(data: unknown, eventType: string): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const refKeys = getEventDataRefFields(eventType);
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

  // Error events carry a StructuredError in eventData.error. Check both the
  // nested field and the top-level value for legacy payloads.
  if (
    getEventDataRefFields(eventType).includes('error') &&
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
  showSeparateEventOccurrenceTimestamps = false,
}: {
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  onStreamClick?: (streamId: string) => void;
  onRunClick?: (runId: string) => void;
  /** When provided, signals that decryption is active (triggers re-load of expanded events) */
  encryptionKey?: Uint8Array;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
}) {
  // Sort by the timestamp shown as Created by default.
  const sortedEvents = useMemo(
    () =>
      [...events].sort(
        (a, b) =>
          getEffectiveEventDate(a).getTime() -
          getEffectiveEventDate(b).getTime()
      ),
    [events]
  );

  const hasEvents = sortedEvents.length > 0 && !error;

  if (!hasEvents && !isLoading) {
    return <Collapsible label="Events" disabled />;
  }

  return (
    <RunClickContext.Provider value={onRunClick}>
      <StreamClickContext.Provider value={onStreamClick}>
        <CollapsibleRoot defaultOpen>
          <CollapsibleTrigger>Events</CollapsibleTrigger>
          <CollapsibleContent className="mb-0">
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
                    showSeparateEventOccurrenceTimestamps={
                      showSeparateEventOccurrenceTimestamps
                    }
                  />
                ))}
              </div>
            )}
          </CollapsibleContent>
        </CollapsibleRoot>
      </StreamClickContext.Provider>
    </RunClickContext.Provider>
  );
}
