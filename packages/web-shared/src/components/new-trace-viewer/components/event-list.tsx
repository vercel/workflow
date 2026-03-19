import { Circle, Clock, Play, StepForward, Webhook } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';

interface EventStyle {
  icon: LucideIcon;
  className: string;
}

const eventStyles: Record<string, EventStyle> = {
  run: { icon: Play, className: 'bg-blue-200 text-blue-900' },
  step: { icon: StepForward, className: 'bg-green-200 text-green-900' },
  hook: { icon: Webhook, className: 'bg-yellow-200 text-yellow-900' },
  sleep: { icon: Clock, className: 'bg-gray-200 text-gray-900' },
};

const defaultStyle: EventStyle = {
  icon: Circle,
  className: 'bg-gray-200 text-gray-900',
};

function getEventStyle(resource: string, isErrored: boolean): EventStyle {
  const style = eventStyles[resource] ?? defaultStyle;
  return {
    icon: style.icon,
    className: cn(
      'rounded-sm p-1',
      isErrored ? 'bg-red-200 text-red-900' : style.className
    ),
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
  const durationMs = getHighResInMs(span.duration);
  const isErrored =
    (span.attributes.data as Record<string, unknown>).status === 'failed';
  const { icon: Icon, className: tagClassName } = getEventStyle(
    span.resource,
    isErrored
  );

  return (
    <li
      className="overflow-clip group"
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      onClick={() => onSelectSpan(span.spanId)}
    >
      <div className="hover:bg-gray-100 group-aria-selected:bg-gray-100 group-aria-selected:hover:bg-gray-200 hover:aria-selected:bg-gray-100 rounded-sm px-2 h-9 py-1.5 flex">
        <div className="flex items-center gap-2">
          <span className={tagClassName}>
            <Icon className="w-4 h-4" />
          </span>
          <span className="text-label-14">{span.name}</span>
        </div>
        <div className="ml-auto">
          <span className="text-label-14 text-gray-900 tabular-nums">
            {formatDuration(durationMs)}
          </span>
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
    <ul
      id="event-list"
      role="tree"
      className="block min-h-0 overflow-visible px-2 py-2"
    >
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
