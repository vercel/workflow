import { Circle } from 'lucide-react';
import { useRef } from 'react';
import { cn } from '../../../lib/cn';
import { formatDurationPrecise } from '../../trace-viewer/util/timing';
import {
  SleepIcon,
  StepForwardIcon,
  WebhookIcon,
  WorkflowIcon,
} from '../icons';
import { isSpanDimmedBySearch, type SpanSearchResult } from '../search';
import type { Span } from '../types';
import { getSpanDurationMs, isSpanErrored } from '../utils';
import { MiddleTruncate } from './middle-truncate/middle-truncate';
import { ROW_HEIGHT_PX, useRowWindow } from './use-row-window';

interface EventStyle {
  icon: React.ComponentType<{ className?: string }>;
  className: string;
}

const eventStyles: Record<string, EventStyle> = {
  run: { icon: WorkflowIcon, className: 'text-blue-900' },
  step: { icon: StepForwardIcon, className: 'text-green-900' },
  hook: { icon: WebhookIcon, className: 'text-gray-900' },
  sleep: { icon: SleepIcon, className: 'text-gray-900' },
};

const defaultStyle: EventStyle = {
  icon: Circle,
  className: 'text-gray-900',
};

const ROW_HEIGHT_CLASS = 'h-10';

function getEventStyle(resource: string, isErrored: boolean): EventStyle {
  const style = eventStyles[resource] ?? defaultStyle;
  return {
    icon: style.icon,
    className: cn(isErrored ? 'text-red-900' : style.className),
  };
}

const EventRow = ({
  span,
  isSelected,
  isDimmed,
  onSelectSpan,
}: {
  span: Span;
  isSelected: boolean;
  isDimmed?: boolean;
  onSelectSpan: (spanId: string) => void;
}) => {
  const durationMs = getSpanDurationMs(span);
  const isErrored = isSpanErrored(span);
  const { icon: Icon, className: tagClassName } = getEventStyle(
    span.resource,
    isErrored
  );

  return (
    <li
      className={cn(
        'relative overflow-clip group transition-opacity',
        ROW_HEIGHT_CLASS,
        isDimmed && 'opacity-35'
      )}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      onClick={() => onSelectSpan(span.spanId)}
    >
      <div className="h-full hover:bg-gray-100 group-aria-selected:bg-gray-100 group-aria-selected:hover:bg-gray-200">
        <div className="flex h-full min-w-0 items-center pl-4 pr-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className={cn('shrink-0', tagClassName)}>
              <Icon className="w-4 h-4" />
            </span>
            <span className="min-w-0 text-label-14">
              <MiddleTruncate value={span.name} />
            </span>
          </div>
          <div className="ml-2 shrink-0">
            <span className="text-label-14 text-gray-900 tabular-nums">
              {formatDurationPrecise(durationMs)}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
};

const EventList = ({
  spans,
  activeSpanId,
  searchResult,
  onSelectSpan,
}: {
  spans: Span[];
  activeSpanId: string | null;
  searchResult: SpanSearchResult;
  onSelectSpan: (spanId: string) => void;
}) => {
  const listRef = useRef<HTMLUListElement>(null);
  const { start, end } = useRowWindow(listRef, spans.length, ROW_HEIGHT_PX);

  return (
    <ul
      ref={listRef}
      id="event-list"
      role="tree"
      className="block min-h-0 overflow-visible divide-y divide-gray-400 border-b border-gray-400"
      style={{
        paddingTop: start * ROW_HEIGHT_PX,
        paddingBottom: (spans.length - end) * ROW_HEIGHT_PX,
      }}
    >
      {spans.slice(start, end).map((span) => (
        <EventRow
          key={span.spanId}
          span={span}
          isSelected={span.spanId === activeSpanId}
          isDimmed={isSpanDimmedBySearch(span.spanId, searchResult)}
          onSelectSpan={onSelectSpan}
        />
      ))}
    </ul>
  );
};

export default EventList;
