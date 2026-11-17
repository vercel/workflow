'use client';

import { type Event, getEventDataRefFields } from '@workflow/world';
import { useMemo, useState } from 'react';
import { DUPLICATE_EVENT_MESSAGE } from '../../lib/duplicate-events';
import { sortEventsByTime } from '../../lib/event-list-model';
import {
  isSealedNoopEvent,
  SEALED_EVENT_MESSAGE,
} from '../../lib/sealed-events';
import { EventIdentifiers } from '../event-details/event-identifiers';
import { EventPayloadSection } from '../event-details/event-payload-section';
import { EventTypeLabel } from '../event-details/event-type-label';
import { useEventPayload } from '../event-details/use-event-payload';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { RunClickContext, StreamClickContext } from '../ui/data-inspector';
import { Skeleton } from '../ui/skeleton';
import { TimestampTooltip } from '../ui/timestamp-tooltip';
import { DetailMonoKeyValueRow } from './attributes-block';

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
  isDuplicate = false,
}: {
  event: Event;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  /** When this changes (e.g., Decrypt was clicked), reload the payload decrypted */
  encryptionKey?: Uint8Array;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  /** The event repeats a class already in the log, so the runtime ignored it. */
  isDuplicate?: boolean;
}) {
  // Cancellation reasons are left out of the sidebar's event details, and an
  // event with no data and no ref fields has nothing to load.
  const canHaveData =
    event.eventType !== 'run_cancelled' &&
    (event.eventData != null ||
      getEventDataRefFields(event.eventType).length > 0);
  // Load only once the card has been expanded, then keep it current.
  const [wasExpanded, setWasExpanded] = useState(false);
  const payload = useEventPayload({
    event,
    onLoadEventData,
    encryptionKey,
    enabled: wasExpanded && canHaveData,
  });

  const rowNotice = isDuplicate
    ? DUPLICATE_EVENT_MESSAGE
    : isSealedNoopEvent(event)
      ? SEALED_EVENT_MESSAGE
      : undefined;
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

  return (
    <CollapsibleRoot
      variant="card"
      onOpenChange={(open) => {
        if (open) setWasExpanded(true);
      }}
    >
      <CollapsibleTrigger className="px-3 py-2">
        <div className="flex w-full items-center justify-between gap-3">
          <EventTypeLabel
            eventType={event.eventType}
            notice={rowNotice}
            className={`text-label-12 font-mono ${
              rowNotice ? 'text-gray-700' : 'text-gray-1000'
            }`}
          />
          <span className="shrink-0 text-label-13 text-gray-900">
            {displayedCreatedAtTime}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* Event attributes */}
        <div className="flex flex-col bg-background-200 px-3 py-2 [&:has(+_*)]:border-b [&:has(+_*)]:border-gray-alpha-400">
          {showSeparateEventOccurrenceTimestamps && occurredAt && (
            <DetailMonoKeyValueRow
              label="Occurred"
              value={
                <TimestampTooltip date={occurredAt}>
                  <span>{formatEventTimestamp(occurredAt)}</span>
                </TimestampTooltip>
              }
            />
          )}
          <EventIdentifiers event={event} />
        </div>

        {canHaveData && (
          <EventPayloadSection
            eventType={event.eventType}
            payload={payload}
            variant="card"
          />
        )}
      </CollapsibleContent>
    </CollapsibleRoot>
  );
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
  duplicateEventIds,
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
  /**
   * Events every replay reads past as repeats, from the caller that holds the
   * whole log. `events` here is one entity's slice of it, which cannot answer
   * the question on its own.
   */
  duplicateEventIds?: ReadonlySet<string>;
}) {
  // Sort by the timestamp shown as Created by default.
  const sortedEvents = useMemo(() => sortEventsByTime(events, 'asc'), [events]);

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
                    isDuplicate={duplicateEventIds?.has(event.eventId)}
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
