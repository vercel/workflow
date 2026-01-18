'use client';

import type { Event } from '@workflow/world';
import { useMemo } from 'react';
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
          gridTemplateColumns: '120px 1fr 140px 200px',
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-background-100)',
          color: 'var(--ds-gray-700)',
        }}
      >
        <div className="px-3">Time</div>
        <div className="px-3">Event Type</div>
        <div className="px-3">Correlation ID</div>
        <div className="px-3">Event ID</div>
      </div>

      {/* Event rows */}
      <div className="flex flex-col gap-2">
        {sortedEvents.map((event) => {
          const colors = getEventColor(event.eventType);
          const createdAt = new Date(event.createdAt);

          return (
            <div
              key={event.eventId}
              className="grid gap-3 items-center rounded-lg border px-0 py-2 text-xs transition-all hover:shadow-sm"
              style={{
                gridTemplateColumns: '120px 1fr 140px 200px',
                backgroundColor: colors.background,
                borderColor: colors.border,
                borderLeftWidth: '3px',
                borderLeftColor: colors.color,
              }}
            >
              {/* Time */}
              <div
                className="px-3 font-mono tabular-nums"
                style={{ color: colors.secondary }}
              >
                {formatEventTime(createdAt)}
              </div>

              {/* Event Type */}
              <div className="px-3 font-medium" style={{ color: colors.text }}>
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
                className="px-3 font-mono truncate"
                style={{ color: colors.secondary }}
                title={event.correlationId || '-'}
              >
                {event.correlationId
                  ? event.correlationId.slice(0, 12) + '...'
                  : '-'}
              </div>

              {/* Event ID */}
              <div
                className="px-3 font-mono truncate"
                style={{ color: colors.secondary }}
                title={event.eventId}
              >
                {event.eventId.slice(0, 16) + '...'}
              </div>
            </div>
          );
        })}
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
