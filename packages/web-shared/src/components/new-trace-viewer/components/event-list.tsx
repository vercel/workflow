import { Circle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { formatDuration } from '../../trace-viewer/util/timing';
import {
  WorkflowIcon,
  WebhookIcon,
  SleepIcon,
  StepForwardIcon,
} from '../icons';
import { getSpanDurationMs } from '../utils';
import { MiddleTruncate } from './middle-truncate/middle-truncate';

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
  onSelectSpan,
}: {
  span: Span;
  isSelected: boolean;
  onSelectSpan: (spanId: string) => void;
}) => {
  const durationMs = getSpanDurationMs(span);
  const isErrored =
    (span.attributes.data as Record<string, unknown>).status === 'failed';
  const { icon: Icon, className: tagClassName } = getEventStyle(
    span.resource,
    isErrored
  );

  return (
    <li
      className={cn(
        'relative overflow-clip group after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-gray-alpha-400',
        ROW_HEIGHT_CLASS
      )}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      onClick={() => onSelectSpan(span.spanId)}
    >
      <div className="h-full hover:bg-gray-100 group-aria-selected:bg-gray-100 group-aria-selected:hover:bg-gray-200">
        <div className="flex h-full min-w-0 items-center px-2">
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
              {formatDuration(durationMs)}
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
  onSelectSpan,
}: {
  spans: Span[];
  activeSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
}) => {
  return (
    <ul id="event-list" role="tree" className="block min-h-0 overflow-visible">
      {spans.map((span) => {
        return (
          <EventRow
            key={span.spanId}
            span={span}
            isSelected={span.spanId === activeSpanId}
            onSelectSpan={onSelectSpan}
          />
        );
      })}
    </ul>
  );
};

export default EventList;
