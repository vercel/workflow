'use client';

import type { Event, WorkflowRun } from '@workflow/world';
import { AlertCircle } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { cn } from '../lib/cn';
import { findDuplicateEventIds } from '../lib/duplicate-events';
import {
  buildEventLookups,
  buildEventRow,
  buildListItems,
  type EventSearchState,
  getEmptyMessage,
  getEventEntity,
  getFooterLabel,
  getListSource,
  getSearchHint,
  mergeEventsById,
  sortEventsByTime,
} from '../lib/event-list-model';
import { EventDetailsPanel } from './event-list/event-details-panel';
import { EventListToolbar } from './event-list/event-list-toolbar';
import {
  EventListHeader,
  EventRow,
  EventRowsSkeleton,
  type EventSortOrder,
  IdleGapRow,
} from './event-list/event-row';
import {
  type ExactSearchHandler,
  useEventSearch,
} from './event-list/use-event-search';
import { useDetailPanelWidth } from './trace-viewer/components/use-detail-panel-width';
import { Button } from './ui/button';
import { ContextCardProvider } from './ui/context-card';
import { DecryptClickContext } from './ui/data-inspector';
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
  /** Sort order for events. Uncontrolled (starting at 'asc') when unset. */
  sortOrder?: EventSortOrder;
  /** Called when the Time header's sort is toggled. */
  onSortOrderChange?: (order: EventSortOrder) => void;
  /** Called when the user clicks the Decrypt button. */
  onDecrypt?: () => void;
  /** Whether the encryption key is currently being fetched. */
  isDecrypting?: boolean;
  /** Whether decryption is unavailable. */
  isDecryptDisabled?: boolean;
  /** Explains why decryption is unavailable. */
  decryptDisabledReason?: string;
  /** Fetch events for an exact correlation or event ID. */
  onExactIdSearch?: ExactSearchHandler;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  onViewInTrace?: (spanId: string) => void;
}

function EmptyState({
  search,
  onRetry,
}: {
  search: EventSearchState;
  onRetry: () => void;
}) {
  if (search.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-2 text-label-14 font-medium text-gray-1000">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-800" />
            Failed to search events
          </div>
          {search.message ? (
            <p className="m-0 text-copy-13 text-gray-900">{search.message}</p>
          ) : null}
        </div>
        <Button variant="secondary" size="small" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-copy-14 text-gray-900">
      {getEmptyMessage(search)}
    </div>
  );
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
  sortOrder: sortOrderProp,
  onSortOrderChange,
  onDecrypt,
  isDecrypting = false,
  isDecryptDisabled = false,
  decryptDisabledReason,
  onExactIdSearch,
  showSeparateEventOccurrenceTimestamps = false,
  onViewInTrace,
}: EventsListProps) {
  const [internalSortOrder, setInternalSortOrder] =
    useState<EventSortOrder>('asc');
  const sortOrder = sortOrderProp ?? internalSortOrder;
  const handleSortOrderChange = onSortOrderChange ?? setInternalSortOrder;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();
  const { query, setQuery, search, retry } = useEventSearch(onExactIdSearch);
  const list = getListSource(search, { events, hasMore: hasMoreEvents });

  // Rows come from the list's source; names and timings from every event on
  // hand.
  const sortedEvents = useMemo(
    () => sortEventsByTime(list.events, sortOrder),
    [list.events, sortOrder]
  );
  const knownEvents = useMemo(
    () => mergeEventsById(events ?? [], list.events),
    [events, list.events]
  );

  // Events every replay reads past as repeats. A page short of the whole log,
  // or an exact-ID search, cannot answer that question, so both classify
  // nothing (see findDuplicateEventIds).
  const isCompleteHistory = list.isLog && !list.hasMore;
  const duplicateEventIds = useMemo(
    () => findDuplicateEventIds(events ?? [], { isCompleteHistory }),
    [events, isCompleteHistory]
  );

  const lookups = useMemo(
    () => buildEventLookups(knownEvents, run ?? null, duplicateEventIds),
    [knownEvents, run, duplicateEventIds]
  );
  const rows = useMemo(
    () => sortedEvents.map((event) => buildEventRow(event, lookups)),
    [sortedEvents, lookups]
  );
  const listItems = useMemo(
    () =>
      buildListItems(rows, {
        showGaps: list.isLog,
        hookNameMap: lookups.names.hookNameMap,
      }),
    [rows, list.isLog, lookups]
  );

  const toggleSelectedEvent = useCallback((event: Event) => {
    setSelectedEventId((id) =>
      id === event.eventId ? undefined : event.eventId
    );
  }, []);
  const selectedRow = useMemo(() => {
    if (!selectedEventId) return undefined;
    const event = knownEvents.find((e) => e.eventId === selectedEventId);
    return event ? buildEventRow(event, lookups) : undefined;
  }, [selectedEventId, knownEvents, lookups]);

  // Every event of the step, hook, wait or run an exact-ID search found is
  // marked; with no search result, those of the selected event's.
  const relatedKey =
    search.status === 'ok'
      ? search.id.kind === 'event'
        ? getEventEntity(search.events[0]).key
        : search.id.id
      : (selectedRow?.entity.key ?? null);

  const [visibleRange, setVisibleRange] = useState({
    startIndex: 0,
    endIndex: 0,
  });
  const relatedIndexes = useMemo(
    () =>
      listItems.flatMap((item, i) =>
        item.kind === 'event' && item.row.entity.key === relatedKey ? [i] : []
      ),
    [listItems, relatedKey]
  );
  const relatedAbove = relatedIndexes.filter(
    (i) => i < visibleRange.startIndex
  );
  const relatedBelow = relatedIndexes.filter((i) => i > visibleRange.endIndex);
  const scrollToItem = (index: number) =>
    virtuosoRef.current?.scrollToIndex({
      index,
      align: 'center',
      behavior: 'smooth',
    });

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
    ? rows.findIndex((row) => row.event.eventId === selectedEventId)
    : -1;

  // Move the selection by one event, keeping the row in view and focused.
  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (rows.length === 0) return;
      const nextIndex =
        selectedIndex === -1
          ? 0
          : Math.min(Math.max(selectedIndex + delta, 0), rows.length - 1);
      const next = rows[nextIndex].event;
      setSelectedEventId(next.eventId);
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
    [selectedIndex, rows, listItems]
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

  const toolbar = (
    <EventListToolbar
      query={query}
      hint={getSearchHint(search)}
      onQueryChange={setQuery}
    />
  );

  if (isInitialLoad) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background-100">
        {toolbar}
        <EventListHeader
          showOccurred={showSeparateEventOccurrenceTimestamps}
          sortOrder={sortOrder}
          onSortOrderChange={handleSortOrderChange}
        />
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
              sortOrder={sortOrder}
              onSortOrderChange={handleSortOrderChange}
            />

            {isRefetching || search.status === 'loading' ? (
              <EventRowsSkeleton />
            ) : rows.length === 0 ? (
              <EmptyState search={search} onRetry={retry} />
            ) : (
              <div className="relative flex min-h-0 flex-1 flex-col">
                <Virtuoso
                  ref={virtuosoRef}
                  rangeChanged={setVisibleRange}
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
                    if (list.hasMore && !isLoadingMoreEvents) {
                      void onLoadMoreEvents?.();
                    }
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
                        sincePreviousMs={item.sincePreviousMs}
                        isSelected={isSelected}
                        isTabStop={
                          selectedIndex === -1 ? item.index === 0 : isSelected
                        }
                        relation={
                          relatedKey === null
                            ? undefined
                            : row.entity.key === relatedKey
                              ? 'related'
                              : 'unrelated'
                        }
                        onSelect={toggleSelectedEvent}
                        showSeparateEventOccurrenceTimestamps={
                          showSeparateEventOccurrenceTimestamps
                        }
                      />
                    );
                  }}
                  style={{ flex: 1, minHeight: 0 }}
                />
                {relatedAbove.length > 0 && (
                  <RelatedHint
                    direction="above"
                    count={relatedAbove.length}
                    onClick={() => scrollToItem(relatedAbove.at(-1) ?? 0)}
                  />
                )}
                {relatedBelow.length > 0 && (
                  <RelatedHint
                    direction="below"
                    count={relatedBelow.length}
                    onClick={() => scrollToItem(relatedBelow[0])}
                  />
                )}
              </div>
            )}

            <div className="relative flex h-10 shrink-0 items-center border-t border-gray-alpha-400 px-4 text-label-13 text-gray-900">
              <span>
                {getFooterLabel(search, {
                  total: sortedEvents.length,
                  hasMoreEvents,
                })}
              </span>
              {list.hasMore && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="pointer-events-auto">
                    <Button
                      variant="secondary"
                      loading={isLoadingMoreEvents}
                      onClick={() => void onLoadMoreEvents?.()}
                    >
                      Load more
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {selectedRow ? (
            <EventDetailsPanel
              row={selectedRow}
              onLoadEventData={onLoadEventData}
              cachedEventData={
                eventDataCacheRef.current.get(selectedRow.event.eventId) ?? null
              }
              onCacheEventData={cacheEventData}
              encryptionKey={encryptionKey}
              width={panelWidth}
              onPrev={selectedIndex > 0 ? () => moveSelection(-1) : undefined}
              onNext={
                selectedIndex >= 0 && selectedIndex < rows.length - 1
                  ? () => moveSelection(1)
                  : undefined
              }
              onClose={() => setSelectedEventId(undefined)}
              onViewInTrace={onViewInTrace}
            />
          ) : null}
        </div>
      </div>
    </DecryptClickContext.Provider>
  );
}

function RelatedHint({
  direction,
  count,
  onClick,
}: {
  direction: 'above' | 'below';
  count: number;
  onClick: () => void;
}) {
  const label = `${count} related ${count === 1 ? 'event' : 'events'}`;
  const layer = cn('absolute inset-0', direction === 'above' && '-scale-y-100');
  return (
    <button
      type="button"
      aria-label={`${label} ${direction}`}
      onClick={onClick}
      className={cn(
        'group absolute inset-x-0 z-10 flex h-10 cursor-pointer justify-end px-3 py-2 outline-none transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:shadow-[inset_0_0_0_2px_var(--ds-focus-color)] starting:opacity-0',
        direction === 'above' ? 'top-0 items-start' : 'bottom-0 items-end'
      )}
    >
      <span
        aria-hidden
        className={cn(
          layer,
          'bg-[linear-gradient(to_top,color-mix(in_oklab,var(--ds-background-100)_70%,transparent),30%,transparent)]'
        )}
      />
      <span
        aria-hidden
        className={cn(
          layer,
          'bg-[linear-gradient(to_top,color-mix(in_oklab,var(--ds-blue-500)_60%,transparent),30%,transparent)] opacity-45 transition-opacity duration-300 ease-[ease] group-hover:opacity-100 group-hover:duration-150 group-focus-visible:opacity-100 group-active:opacity-75 group-active:duration-75'
        )}
      />
      <span className="relative font-medium text-label-12 text-blue-900">
        {label}
      </span>
    </button>
  );
}

export function EventListView(props: EventsListProps) {
  return (
    <TooltipProvider>
      <ContextCardProvider>
        <EventListViewInner {...props} />
      </ContextCardProvider>
    </TooltipProvider>
  );
}
