'use client';

import type { Event } from '@workflow/world';
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
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
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface EventsListProps {
  events: Event[] | null;
}

/**
 * Single event row component with expandable details
 */
function EventRow({ event }: { event: Event }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const colors = getEventColor(event.eventType);
  const createdAt = new Date(event.createdAt);

  // Get event data if it exists
  const eventData = 'eventData' in event ? event.eventData : null;

  return (
    <div
      className="rounded-lg border overflow-hidden transition-all"
      style={{
        backgroundColor: colors.background,
        borderColor: colors.border,
        borderLeftWidth: '3px',
        borderLeftColor: colors.color,
      }}
    >
      {/* Clickable row header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-left grid gap-3 items-center px-0 py-2 text-xs hover:brightness-[0.98] transition-all cursor-pointer"
        style={{
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
          {eventData && (
            <div className="mt-3">
              <div
                className="text-xs font-medium mb-1.5"
                style={{ color: 'var(--ds-gray-700)' }}
              >
                Event Data
              </div>
              <pre
                className="text-[11px] overflow-x-auto rounded-md border p-3"
                style={{
                  borderColor: 'var(--ds-gray-300)',
                  backgroundColor: 'var(--ds-gray-100)',
                  color: 'var(--ds-gray-1000)',
                }}
              >
                <code>{JSON.stringify(eventData, null, 2)}</code>
              </pre>
            </div>
          )}
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
export function EventsList({ events }: EventsListProps) {
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
    <div className="h-full overflow-auto p-4">
      {/* Header row */}
      <div
        className="grid gap-3 pb-2 mb-2 border-b text-xs font-medium sticky top-0 z-10"
        style={{
          gridTemplateColumns: '24px 100px minmax(120px, auto) 1fr 1fr',
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-background-100)',
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
          <EventRow key={event.eventId} event={event} />
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
