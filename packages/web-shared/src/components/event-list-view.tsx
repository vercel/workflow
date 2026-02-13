'use client';

import type { Event } from '@workflow/world';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ObjectInspector } from 'react-inspector';
import { useDarkMode } from '../hooks/use-dark-mode';
import { inspectorThemeDark, inspectorThemeLight } from './ui/inspector-theme';
import { getEventColor } from './workflow-traces/event-colors';

/**
 * Format a date to a human-readable local time string with milliseconds
 */
function formatEventTime(date: Date): string {
  return (
    date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) +
    '.' +
    date.getMilliseconds().toString().padStart(3, '0')
  );
}

/**
 * Format a date to full local datetime string with milliseconds
 */
function formatEventDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    fractionalSecondDigits: 3,
  });
}

/**
 * Format event type to a more readable label
 */
function formatEventType(eventType: Event['eventType']): string {
  return eventType
    .split('_')
    .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface EventsListProps {
  events: Event[] | null;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
}

/**
 * Single event row component with expandable details
 */
function EventRow({
  event,
  onLoadEventData,
}: {
  event: Event;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
}) {
  const isDark = useDarkMode();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadedEventData, setLoadedEventData] = useState<unknown | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const colors = getEventColor(event.eventType);
  const createdAt = new Date(event.createdAt);

  // Check if event already has eventData (from initial fetch)
  const hasExistingEventData = 'eventData' in event && event.eventData != null;

  // Load full event details when expanding
  const loadEventDetails = useCallback(async () => {
    // Skip if we already have data or no correlationId
    if (
      loadedEventData !== null ||
      hasExistingEventData ||
      !event.correlationId
    ) {
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      if (!onLoadEventData) {
        setLoadError('Event details unavailable');
        return;
      }
      const eventData = await onLoadEventData(event);
      if (eventData !== null && eventData !== undefined) {
        setLoadedEventData(eventData);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Failed to load event details'
      );
    } finally {
      setIsLoading(false);
    }
  }, [
    event.correlationId,
    loadedEventData,
    hasExistingEventData,
    onLoadEventData,
  ]);

  // Handle expand/collapse
  const handleToggle = useCallback(() => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);

    // Load details when expanding for the first time
    if (newExpanded && loadedEventData === null && !hasExistingEventData) {
      loadEventDetails();
    }
  }, [isExpanded, loadedEventData, hasExistingEventData, loadEventDetails]);

  // Get the event data to display (either from initial fetch, loaded data, or null)
  const eventData = hasExistingEventData
    ? (event as Event & { eventData: unknown }).eventData
    : loadedEventData;

  return (
    <div
      className="rounded-lg border overflow-hidden transition-all"
      style={{
        backgroundColor: 'var(--ds-background-100)',
        borderColor: colors.border,
        borderLeftWidth: '1px',
        borderLeftColor: colors.color,
      }}
    >
      {/* Clickable row header */}
      <button
        type="button"
        onClick={handleToggle}
        className="w-full text-left grid gap-3 items-center px-0 py-2 text-xs hover:brightness-[0.98] transition-all cursor-pointer"
        style={{
          backgroundColor: 'var(--ds-background-100)',
          gridTemplateColumns: '24px 100px minmax(120px, auto) 1fr 1fr',
        }}
      >
        {/* Expand icon */}
        <div className="flex justify-center">
          <ChevronRight
            className="h-3.5 w-3.5 transition-transform"
            style={{
              color: colors.secondary,
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          />
        </div>

        {/* Time */}
        <div
          className="font-mono tabular-nums"
          style={{ color: colors.secondary }}
        >
          {formatEventTime(createdAt)}
        </div>

        {/* Event Type */}
        <div className="font-medium" style={{ color: colors.text }}>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: colors.color }}
            />
            {formatEventType(event.eventType)}
          </span>
        </div>

        {/* Correlation ID */}
        <div
          className="font-mono text-[11px] overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ color: colors.secondary }}
          title={event.correlationId || '-'}
        >
          {event.correlationId || '-'}
        </div>

        {/* Event ID */}
        <div
          className="font-mono text-[11px] pr-3 overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ color: colors.secondary }}
          title={event.eventId}
        >
          {event.eventId}
        </div>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div
          className="border-t px-4 py-3"
          style={{
            borderColor: colors.border,
            backgroundColor: 'var(--ds-background-100)',
          }}
        >
          {/* Event attributes in a structured table */}
          <div
            className="flex flex-col divide-y rounded-md border overflow-hidden"
            style={{
              borderColor: 'var(--ds-gray-300)',
              backgroundColor: 'var(--ds-gray-100)',
            }}
          >
            <AttributeRow label="Event ID" value={event.eventId} mono />
            <AttributeRow label="Event Type" value={event.eventType} />
            <AttributeRow
              label="Correlation ID"
              value={event.correlationId || '-'}
              mono
            />
            <AttributeRow label="Run ID" value={event.runId} mono />
            <AttributeRow
              label="Created At"
              value={formatEventDateTime(createdAt)}
            />
          </div>

          {/* Event data section */}
          <div className="mt-3">
            <div
              className="text-xs font-medium mb-1.5"
              style={{ color: 'var(--ds-gray-700)' }}
            >
              Event Data
            </div>

            {/* Loading state */}
            {isLoading && (
              <div
                className="flex items-center gap-2 rounded-md border p-3"
                style={{
                  borderColor: 'var(--ds-gray-300)',
                  backgroundColor: 'var(--ds-gray-100)',
                }}
              >
                <Loader2
                  className="h-4 w-4 animate-spin"
                  style={{ color: 'var(--ds-gray-700)' }}
                />
                <span
                  className="text-xs"
                  style={{ color: 'var(--ds-gray-700)' }}
                >
                  Loading event details...
                </span>
              </div>
            )}

            {/* Error state */}
            {loadError && !isLoading && (
              <div
                className="rounded-md border p-3 text-xs"
                style={{
                  borderColor: 'var(--ds-red-400)',
                  backgroundColor: 'var(--ds-red-100)',
                  color: 'var(--ds-red-900)',
                }}
              >
                {loadError}
              </div>
            )}

            {/* Event data display */}
            {!isLoading && !loadError && eventData != null && (
              <div
                className="overflow-x-auto rounded-md border p-3"
                style={{ borderColor: 'var(--ds-gray-300)' }}
              >
                <ObjectInspector
                  data={eventData}
                  // @ts-expect-error react-inspector accepts theme objects at runtime
                  // see https://github.com/storybookjs/react-inspector/blob/main/README.md#theme
                  theme={isDark ? inspectorThemeDark : inspectorThemeLight}
                  expandLevel={2}
                />
              </div>
            )}

            {/* No event data */}
            {!isLoading &&
              !loadError &&
              eventData == null &&
              !event.correlationId && (
                <div
                  className="rounded-md border p-3 text-xs"
                  style={{
                    borderColor: 'var(--ds-gray-300)',
                    backgroundColor: 'var(--ds-gray-100)',
                    color: 'var(--ds-gray-700)',
                  }}
                >
                  No event data available
                </div>
              )}

            {/* No correlation ID - can't load data */}
            {!isLoading &&
              !loadError &&
              eventData == null &&
              event.correlationId &&
              !hasExistingEventData &&
              loadedEventData === null && (
                <div
                  className="rounded-md border p-3 text-xs"
                  style={{
                    borderColor: 'var(--ds-gray-300)',
                    backgroundColor: 'var(--ds-gray-100)',
                    color: 'var(--ds-gray-700)',
                  }}
                >
                  No event data for this event type
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Helper component for attribute rows in the expanded details
 */
function AttributeRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between px-2.5 py-1.5"
      style={{ borderColor: 'var(--ds-gray-300)' }}
    >
      <span
        className="text-[11px] font-medium"
        style={{ color: 'var(--ds-gray-700)' }}
      >
        {label}
      </span>
      <span
        className={`text-[11px] ${mono ? 'font-mono' : ''} text-right max-w-[70%] break-all`}
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Displays a list of all events for a workflow run as colored cards in a pseudo-table.
 * Events are sorted by createdAt (oldest first).
 */
export function EventListView({ events, onLoadEventData }: EventsListProps) {
  // Sort events by createdAt (oldest first)
  const sortedEvents = useMemo(() => {
    if (!events || events.length === 0) return [];
    return [...events].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [events]);

  if (!events || events.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-full text-sm"
        style={{ color: 'var(--ds-gray-700)' }}
      >
        No events found
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto m-2">
      {/* Header row */}
      <div
        className="grid gap-3 pb-2 mb-2 border-b text-xs font-medium sticky top-0 z-10"
        style={{
          gridTemplateColumns: '24px 100px minmax(120px, auto) 1fr 1fr',
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'transparent',
          color: 'var(--ds-gray-700)',
        }}
      >
        <div>{/* Expand icon column */}</div>
        <div>Time</div>
        <div>Event Type</div>
        <div>Correlation ID</div>
        <div>Event ID</div>
      </div>

      {/* Event rows */}
      <div className="flex flex-col gap-2">
        {sortedEvents.map((event) => (
          <EventRow
            key={event.eventId}
            event={event}
            onLoadEventData={onLoadEventData}
          />
        ))}
      </div>

      {/* Summary */}
      <div
        className="mt-4 pt-3 border-t text-xs"
        style={{
          borderColor: 'var(--ds-gray-300)',
          color: 'var(--ds-gray-700)',
        }}
      >
        {sortedEvents.length} event{sortedEvents.length !== 1 ? 's' : ''} total
      </div>
    </div>
  );
}
