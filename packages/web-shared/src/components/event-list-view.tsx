'use client';

import type { Event, WorkflowRun } from '@workflow/world';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { findDuplicateEventIds } from '../lib/duplicate-events';
import {
  buildEventLookups,
  buildEventRow,
  buildEventRows,
  buildListItems,
  filterEventRows,
  getEmptyMessage,
  getEventEntity,
  getExactSearchEvents,
  getFooterLabel,
  getStepSegments,
  getTextFilter,
  mergeEventsById,
  sortEventsByTime,
} from '../lib/event-list-model';
import type {
  ExactIdSearchResult,
  ExactWorkflowSearchId,
  ExactWorkflowSearchIdKind,
} from '../lib/exact-event-search-id';
import { EventDetailsPanel } from './event-list/event-details-panel';
import { EventListToolbar } from './event-list/event-list-toolbar';
import {
  EventListHeader,
  EventRow,
  EventRowsSkeleton,
  IdleGapRow,
} from './event-list/event-row';
import { useEventSearch } from './event-list/use-event-search';
import { useDetailPanelWidth } from './trace-viewer/components/use-detail-panel-width';
import { ContextCardProvider } from './ui/context-card';
import { DecryptClickContext } from './ui/data-inspector';
import { LoadMoreButton } from './ui/load-more-button';
import { TooltipProvider } from './ui/tooltip';

interface EventsListProps {
  events: Event[] | null;
  run?: WorkflowRun | null;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  hasMoreEvents?: boolean;
  isLoadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => Promise<void> | void;
  /** When provided, signals that decryption is active (triggers re-load of expanded events) */
  encryptionKey?: Uint8Array;
  /** When true, shows a loading state instead of "No events found" for empty lists */
  isLoading?: boolean;
  /** Sort order for events. Defaults to 'asc'. */
  sortOrder?: 'asc' | 'desc';
  /** @deprecated The Events tab has no sort control; ignored. */
  onSortOrderChange?: (order: 'asc' | 'desc') => void;
  /** Called when the user clicks the Decrypt button. */
  onDecrypt?: () => void;
  /** Whether the encryption key is currently being fetched. */
  isDecrypting?: boolean;
  /** Whether decryption is unavailable. */
  isDecryptDisabled?: boolean;
  /** Explains why decryption is unavailable. */
  decryptDisabledReason?: string;
  /** @deprecated Decrypt is offered on the encrypted payload itself; ignored. */
  hasEncryptedData?: boolean;
  /** Fetch events for an exact correlation or event ID. */
  onExactIdSearch?: (
    id: string,
    kind: ExactWorkflowSearchIdKind,
    signal?: AbortSignal
  ) => Promise<ExactIdSearchResult>;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  /** Shows "View in Trace" in the details panel, with the trace span ID to select. */
  onViewInTrace?: (spanId: string) => void;
}

function EventListViewInner({
  events,
  run,
  onLoadEventData,
  hasMoreEvents = false,
  isLoadingMoreEvents = false,
  onLoadMoreEvents,
  encryptionKey,
  isLoading = false,
  sortOrder = 'asc',
  onDecrypt,
  isDecrypting = false,
  isDecryptDisabled = false,
  decryptDisabledReason,
  onExactIdSearch,
  showSeparateEventOccurrenceTimestamps = false,
  onViewInTrace,
}: EventsListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Selecting an event marks every event of the same step, hook, wait or run.
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();
  const [relatedKey, setRelatedKey] = useState<string | undefined>();

  // An exact-ID search marks the entity it found and scrolls to the top.
  const handleExactResult = useCallback(
    (result: { id: ExactWorkflowSearchId; events: Event[] } | null) => {
      if (!result) {
        setRelatedKey(undefined);
        return;
      }
      setRelatedKey(
        result.id.kind === 'event'
          ? (getEventEntity(result.events[0]).key ?? undefined)
          : result.id.id
      );
      virtuosoRef.current?.scrollToIndex({
        index: 0,
        align: 'start',
        behavior: 'smooth',
      });
    },
    []
  );
  const { query, setQuery, search } = useEventSearch({
    onExactIdSearch,
    onExactResult: handleExactResult,
  });
  const exactEvents = getExactSearchEvents(search);
  const isExactSearchActive = exactEvents !== null;
  const textFilter = getTextFilter(search);

  // Rows come from the list on display: the exact-search results, else the
  // loaded page. Names and timings come from every event on hand.
  const displayedEvents = exactEvents ?? events;
  const sortedEvents = useMemo(
    () => sortEventsByTime(displayedEvents ?? [], sortOrder),
    [displayedEvents, sortOrder]
  );
  const knownEvents = useMemo(
    () => mergeEventsById(events ?? [], exactEvents ?? []),
    [events, exactEvents]
  );

  // Events every replay reads past as repeats. A page short of the whole log,
  // or an exact-ID search, cannot answer that question, so both classify
  // nothing (see findDuplicateEventIds).
  const duplicateEventIds = useMemo(
    () =>
      findDuplicateEventIds(events ?? [], {
        isCompleteHistory: !hasMoreEvents && !isExactSearchActive,
      }),
    [events, hasMoreEvents, isExactSearchActive]
  );

  const lookups = useMemo(
    () => buildEventLookups(knownEvents, run ?? null, duplicateEventIds),
    [knownEvents, run, duplicateEventIds]
  );
  const rows = useMemo(
    () => buildEventRows(sortedEvents, lookups),
    [sortedEvents, lookups]
  );
  const visibleRows = useMemo(
    () => filterEventRows(rows, textFilter),
    [rows, textFilter]
  );
  const listItems = useMemo(
    () =>
      buildListItems(visibleRows, {
        showGaps: !isExactSearchActive && !textFilter,
        hookNameMap: lookups.names.hookNameMap,
      }),
    [visibleRows, isExactSearchActive, textFilter, lookups]
  );

  const selectEvent = useCallback((event: Event | undefined) => {
    setSelectedEventId(event?.eventId);
    setRelatedKey(event ? (getEventEntity(event).key ?? undefined) : undefined);
  }, []);
  const toggleSelectedEvent = useCallback(
    (event: Event) => {
      selectEvent(event.eventId === selectedEventId ? undefined : event);
    },
    [selectedEventId, selectEvent]
  );
  const selectedRow = useMemo(() => {
    if (!selectedEventId) return undefined;
    const event = knownEvents.find((e) => e.eventId === selectedEventId);
    return event ? buildEventRow(event, lookups) : undefined;
  }, [selectedEventId, knownEvents, lookups]);

  // Event data cache: ref avoids re-renders when cache updates
  const eventDataCacheRef = useRef<Map<string, unknown>>(new Map());
  const cacheEventData = useCallback((eventId: string, data: unknown) => {
    eventDataCacheRef.current.set(eventId, data);
  }, []);

  // Track whether we've ever had events to distinguish initial load from refetch
  const hasHadEventsRef = useRef(false);
  if (sortedEvents.length > 0) {
    hasHadEventsRef.current = true;
  }
  const isInitialLoad = isLoading && !hasHadEventsRef.current;
  const isRefetching =
    isLoading && hasHadEventsRef.current && sortedEvents.length === 0;

  const selectedIndex = selectedEventId
    ? visibleRows.findIndex((row) => row.event.eventId === selectedEventId)
    : -1;

  // Move the selection by one event, keeping the row in view and focused.
  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (visibleRows.length === 0) return;
      const nextIndex =
        selectedIndex === -1
          ? 0
          : Math.min(
              Math.max(selectedIndex + delta, 0),
              visibleRows.length - 1
            );
      const next = visibleRows[nextIndex].event;
      selectEvent(next);
      const itemIndex = listItems.findIndex(
        (item) =>
          item.kind === 'event' && item.row.event.eventId === next.eventId
      );
      if (itemIndex >= 0) {
        virtuosoRef.current?.scrollIntoView({ index: itemIndex });
      }
      requestAnimationFrame(() => {
        bodyRef.current
          ?.querySelector<HTMLElement>(
            `[data-event-id="${CSS.escape(next.eventId)}"]`
          )
          ?.focus();
      });
    },
    [selectedIndex, selectEvent, visibleRows, listItems]
  );

  // With no listed row selected, Up/Down or J/K select the first one. Once a
  // listed row is selected, the details panel handles those keys and Escape;
  // it offers no prev/next until then, so a press is handled once.
  const handleListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (selectedIndex !== -1) return;
      if (
        e.key === 'ArrowDown' ||
        e.key === 'j' ||
        e.key === 'ArrowUp' ||
        e.key === 'k'
      ) {
        e.preventDefault();
        moveSelection(1);
      }
    },
    [selectedIndex, moveSelection]
  );

  const panelWidth = useDetailPanelWidth(bodyRef, selectedRow !== undefined);

  const toolbar = <EventListToolbar query={query} onQueryChange={setQuery} />;

  if (isInitialLoad) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background-100">
        {toolbar}
        <EventListHeader showOccurred={showSeparateEventOccurrenceTimestamps} />
        <EventRowsSkeleton />
      </div>
    );
  }

  return (
    <DecryptClickContext.Provider
      value={
        onDecrypt
          ? {
              onDecrypt,
              isDecrypting,
              isDecryptDisabled,
              decryptDisabledReason,
            }
          : undefined
      }
    >
      <div className="flex h-full flex-col overflow-hidden bg-background-100">
        {toolbar}
        <div ref={bodyRef} className="flex min-h-0 flex-1">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard navigation for the rows inside */}
          <div
            className="flex min-w-0 flex-1 flex-col"
            onKeyDown={handleListKeyDown}
          >
            <EventListHeader
              showOccurred={showSeparateEventOccurrenceTimestamps}
            />

            {isRefetching || search.status === 'loading' ? (
              <EventRowsSkeleton />
            ) : visibleRows.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-copy-14 text-gray-900">
                {getEmptyMessage(search)}
              </div>
            ) : (
              <Virtuoso
                ref={virtuosoRef}
                totalCount={listItems.length}
                overscan={20}
                defaultItemHeight={25}
                computeItemKey={(i) => {
                  const item = listItems[i];
                  return item.kind === 'gap'
                    ? item.key
                    : item.row.event.eventId;
                }}
                endReached={() => {
                  if (
                    isExactSearchActive ||
                    !hasMoreEvents ||
                    isLoadingMoreEvents
                  ) {
                    return;
                  }
                  void onLoadMoreEvents?.();
                }}
                components={{ Footer: () => <div className="h-2" /> }}
                itemContent={(i: number) => {
                  const item = listItems[i];
                  if (item.kind === 'gap') {
                    return <IdleGapRow ms={item.ms} reason={item.reason} />;
                  }
                  const { row } = item;
                  const isSelected = selectedEventId === row.event.eventId;
                  return (
                    <EventRow
                      row={row}
                      index={item.index}
                      isSelected={isSelected}
                      isTabStop={
                        selectedIndex === -1 ? item.index === 0 : isSelected
                      }
                      isRelated={
                        relatedKey !== undefined &&
                        row.entity.key === relatedKey
                      }
                      onSelect={toggleSelectedEvent}
                      highlight={textFilter || undefined}
                      showSeparateEventOccurrenceTimestamps={
                        showSeparateEventOccurrenceTimestamps
                      }
                    />
                  );
                }}
                style={{ flex: 1, minHeight: 0 }}
              />
            )}

            <div className="relative flex h-10 shrink-0 items-center border-t border-gray-alpha-400 px-4 text-label-13 text-gray-900">
              <span>
                {getFooterLabel(search, {
                  total: sortedEvents.length,
                  shown: visibleRows.length,
                  hasMoreEvents,
                })}
              </span>
              {!isExactSearchActive && hasMoreEvents && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="pointer-events-auto">
                    <LoadMoreButton
                      loading={isLoadingMoreEvents}
                      onClick={() => void onLoadMoreEvents?.()}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {selectedRow ? (
            <EventDetailsPanel
              row={selectedRow}
              segments={getStepSegments(selectedRow.entity, lookups.timing)}
              onLoadEventData={onLoadEventData}
              cachedEventData={
                eventDataCacheRef.current.get(selectedRow.event.eventId) ?? null
              }
              onCacheEventData={cacheEventData}
              encryptionKey={encryptionKey}
              decrypt={
                onDecrypt
                  ? {
                      onDecrypt,
                      isDecrypting,
                      isDecryptDisabled,
                      decryptDisabledReason,
                    }
                  : undefined
              }
              width={panelWidth}
              onPrev={selectedIndex > 0 ? () => moveSelection(-1) : undefined}
              onNext={
                selectedIndex >= 0 && selectedIndex < visibleRows.length - 1
                  ? () => moveSelection(1)
                  : undefined
              }
              onClose={() => selectEvent(undefined)}
              onViewInTrace={onViewInTrace}
            />
          ) : null}
        </div>
      </div>
    </DecryptClickContext.Provider>
  );
}

export function EventListView(props: EventsListProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <ContextCardProvider>
        <EventListViewInner {...props} />
      </ContextCardProvider>
    </TooltipProvider>
  );
}
