'use client';

import type { Event } from '@workflow/world';
import { ChevronDown, ChevronUp, CircleX, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  type EventLevel,
  type EventListRow,
  formatSinceStart,
  formatTimestampParts,
  getEffectiveEventDate,
  parseEventDate,
} from '../../lib/event-list-model';
import { formatDurationPrecise } from '../../lib/utils';
import { ResourceIcon } from '../trace-viewer/components/event-list';
import { EventNoticeTooltip } from '../ui/duplicate-event-tooltip';
import { Skeleton } from '../ui/skeleton';
import { TimestampTooltip } from '../ui/timestamp-tooltip';

// ──────────────────────────────────────────────────────────────────────────
// Layout
// ──────────────────────────────────────────────────────────────────────────

const COL = {
  level: 'w-6 justify-center',
  time: 'w-[172px]',
  since: 'w-[100px]',
  event: 'w-[136px]',
  name: 'w-[200px]',
  duration: 'w-[96px] justify-end',
} as const;

const CELL = 'flex h-full shrink-0 items-center overflow-hidden px-1.5';

const LEVEL_ROW_CLASS: Record<EventLevel, string> = {
  default: 'text-gray-1000 hover:bg-gray-alpha-200',
  muted: 'text-gray-700 hover:bg-gray-alpha-200',
  warning: 'bg-amber-100 text-amber-900 hover:bg-amber-200',
  error: 'bg-red-100 text-red-900 hover:bg-red-200',
};

/** Column separator before Message, tinted with the row. */
const LEVEL_SEPARATOR_CLASS: Record<EventLevel, string> = {
  default: 'border-gray-400',
  muted: 'border-gray-400',
  warning: 'border-amber-400',
  error: 'border-red-400',
};

const LEVEL_SELECTED_CLASS: Record<EventLevel, string> = {
  default: 'bg-gray-200 hover:bg-gray-200',
  muted: 'bg-gray-200 hover:bg-gray-200',
  warning: 'bg-amber-300 hover:bg-amber-300',
  error: 'bg-red-300 hover:bg-red-300',
};

function TimestampCell({
  date,
  secondaryClass,
}: {
  date: Date;
  secondaryClass?: string;
}) {
  const parts = formatTimestampParts(date);
  return (
    <div className={cn(CELL, COL.time, 'tabular-nums')}>
      <TimestampTooltip date={date}>
        {/* The tooltip trigger lays this span out as a flex row, which would
            trim the space after the day unless whitespace is preserved. */}
        <span className="whitespace-pre">
          <span className={secondaryClass}>{`${parts.day} `}</span>
          {parts.clock}
          <span className={secondaryClass}>{parts.ms}</span>
        </span>
      </TimestampTooltip>
    </div>
  );
}

function LevelIcon({ level }: { level: EventLevel }) {
  if (level === 'warning') {
    return <TriangleAlert aria-label="Warning" className="h-3.5 w-3.5" />;
  }
  if (level === 'error') {
    return <CircleX aria-label="Error" className="h-3.5 w-3.5" />;
  }
  return null;
}

export type EventSortOrder = 'asc' | 'desc';

/**
 * The sort chevrons from the dashboard's Sonar tables: the active direction's
 * chevron slides to the middle and the other fades out.
 */
function SortIndicator({ order }: { order: EventSortOrder }) {
  return (
    <span aria-hidden className="flex flex-col gap-px">
      <span
        className={cn(
          '-my-0.5 flex size-3 items-center justify-center rounded-full transition-all duration-[280ms] ease-in-out',
          order === 'asc'
            ? 'translate-y-1 bg-gray-300 text-gray-900'
            : '-translate-y-1 opacity-0'
        )}
      >
        <ChevronUp className="size-2" strokeWidth={3} />
      </span>
      <span
        className={cn(
          '-my-0.5 flex size-3 items-center justify-center rounded-full transition-all duration-[280ms] ease-in-out',
          order === 'desc'
            ? '-translate-y-1 bg-gray-300 text-gray-900'
            : 'opacity-0'
        )}
      >
        <ChevronDown className="size-2 translate-y-[0.5px]" strokeWidth={3} />
      </span>
    </span>
  );
}

export function EventListHeader({
  showOccurred,
  sortOrder,
  onSortOrderChange,
}: {
  showOccurred: boolean;
  sortOrder: EventSortOrder;
  onSortOrderChange: (order: EventSortOrder) => void;
}): ReactNode {
  // Rows sort by occurredAt when it is set, so the chevron sits on the first
  // time column either way.
  const sortButton = (label: string) => (
    <button
      type="button"
      aria-label={`${label}, ${sortOrder === 'asc' ? 'oldest' : 'newest'} first`}
      onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')}
      className={cn(
        CELL,
        COL.time,
        'cursor-pointer gap-1.5 border-0 bg-transparent text-left font-sans text-label-14 text-gray-900 hover:text-gray-1000'
      )}
    >
      {label}
      <SortIndicator order={sortOrder} />
    </button>
  );
  return (
    <div
      role="row"
      className="mx-1 flex h-10 shrink-0 items-center border-b border-gray-alpha-200 font-sans text-label-14 text-gray-900"
    >
      <div className={cn(CELL, COL.level)} />
      {showOccurred ? (
        <>
          {sortButton('Occurred')}
          <div className={cn(CELL, COL.time)}>Created</div>
        </>
      ) : (
        sortButton('Time')
      )}
      <div className={cn(CELL, COL.since)} />
      <div className={cn(CELL, COL.event)}>Event</div>
      <div className={cn(CELL, COL.name)}>Name</div>
      <div
        className={cn(CELL, 'min-w-0 flex-1 h-3.5 border-l border-gray-400')}
      >
        Message
      </div>
      <div className={cn(CELL, COL.duration)}>Duration</div>
    </div>
  );
}

export function IdleGapRow({ ms, reason }: { ms: number; reason: string }) {
  return (
    <div className="mx-1 mt-px flex h-6 items-center gap-2.5 pl-[30px] pr-2 font-mono text-label-12-mono text-gray-700">
      <span className="h-px w-3 shrink-0 bg-gray-400" />
      <span className="shrink-0">
        {formatDurationPrecise(ms)} idle{reason ? ` · ${reason}` : ''}
      </span>
      <span className="h-px flex-1 bg-gray-400" />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Event row
// ──────────────────────────────────────────────────────────────────────────

export interface EventRowProps {
  row: EventListRow;
  /** Position among events (not gap rows); drives zebra striping. */
  index: number;
  isSelected: boolean;
  /** The one row Tab lands on (roving tabindex): the selection, else the first row. */
  isTabStop: boolean;
  /** The row belongs to the selected event's step, hook, wait or run. */
  isRelated: boolean;
  onSelect: (event: Event) => void;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
}

export function EventRow({
  row,
  index,
  isSelected,
  isTabStop,
  isRelated,
  onSelect,
  showSeparateEventOccurrenceTimestamps = false,
}: EventRowProps) {
  const { event, level, name, message, notice } = row;
  const occurredAt = parseEventDate(event.occurredAt);
  const displayedAt = showSeparateEventOccurrenceTimestamps
    ? new Date(event.createdAt)
    : getEffectiveEventDate(event);
  const zebra = (level === 'default' || level === 'muted') && index % 2 === 1;
  // Tinted rows keep one color throughout.
  const secondaryClass =
    level === 'warning' || level === 'error' ? undefined : 'text-gray-900';

  return (
    <div
      data-event-id={event.eventId}
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-pressed={isSelected}
      onClick={() => onSelect(event)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(event);
        }
      }}
      className={cn(
        'mx-1 mt-px flex h-6 cursor-pointer items-center rounded-md font-mono text-[13px] leading-5 outline-none focus-visible:relative focus-visible:z-10 focus-visible:shadow-[0_0_0_2px_var(--ds-focus-color)]',
        LEVEL_ROW_CLASS[level],
        zebra && 'bg-gray-alpha-100',
        isSelected && LEVEL_SELECTED_CLASS[level]
      )}
    >
      <div className={cn(CELL, COL.level)}>
        <LevelIcon level={level} />
      </div>
      {showSeparateEventOccurrenceTimestamps &&
        (occurredAt ? (
          <TimestampCell date={occurredAt} secondaryClass={secondaryClass} />
        ) : (
          <div className={cn(CELL, COL.time, secondaryClass)}>—</div>
        ))}
      <TimestampCell date={displayedAt} secondaryClass={secondaryClass} />
      <div className={cn(CELL, COL.since, 'tabular-nums', secondaryClass)}>
        {row.sinceStartMs !== undefined
          ? formatSinceStart(row.sinceStartMs)
          : ''}
      </div>
      <div className={cn(CELL, COL.event)}>
        <EventNoticeTooltip notice={notice}>
          <span
            className={cn('truncate', notice && 'line-through')}
            title={event.eventType}
          >
            {event.eventType}
          </span>
        </EventNoticeTooltip>
      </div>
      <div className={cn(CELL, COL.name, 'gap-2')} title={name || undefined}>
        <ResourceIcon
          resource={row.resource}
          isErrored={level === 'error'}
          isCancelled={event.eventType === 'run_cancelled'}
        />
        {name ? (
          <span
            className={cn(
              '-mx-1 truncate rounded px-1',
              isRelated && 'bg-blue-100 text-blue-900'
            )}
          >
            {name}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          CELL,
          'min-w-0 flex-1 h-3.5 border-l',
          LEVEL_SEPARATOR_CLASS[level]
        )}
        title={message || undefined}
      >
        <span className="truncate">{message}</span>
      </div>
      <div className={cn(CELL, COL.duration, 'tabular-nums')}>
        {row.durationMs !== undefined
          ? formatDurationPrecise(row.durationMs)
          : ''}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Skeleton
// ──────────────────────────────────────────────────────────────────────────

const SKELETON_MESSAGE_WIDTHS = ['40%', '0%', '25%', '55%', '0%', '30%'];

export function EventRowsSkeleton() {
  return (
    <div className="flex-1 overflow-hidden pt-px">
      {Array.from({ length: 18 }, (_, i) => (
        <div
          key={i}
          className={cn(
            'mx-1 mt-px flex h-6 items-center rounded-md',
            i % 2 === 1 && 'bg-gray-alpha-100'
          )}
        >
          <div className={cn(CELL, COL.level)} />
          <div className={cn(CELL, COL.time)}>
            <Skeleton className="h-3 w-[136px]" />
          </div>
          <div className={cn(CELL, COL.since)}>
            <Skeleton className="h-3 w-12" />
          </div>
          <div className={cn(CELL, COL.event)}>
            <Skeleton className="h-3 w-[104px]" />
          </div>
          <div className={cn(CELL, COL.name)}>
            <Skeleton className="h-3 w-24" />
          </div>
          <div className={cn(CELL, 'min-w-0 flex-1')}>
            <Skeleton
              className="h-3"
              style={{
                width:
                  SKELETON_MESSAGE_WIDTHS[i % SKELETON_MESSAGE_WIDTHS.length],
              }}
            />
          </div>
          <div className={cn(CELL, COL.duration)} />
        </div>
      ))}
    </div>
  );
}
