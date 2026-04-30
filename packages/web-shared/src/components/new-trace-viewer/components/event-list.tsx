import { Circle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';
import {
  WorkflowIcon,
  WebhookIcon,
  SleepIcon,
  StepForwardIcon,
} from '../icons';

interface EventStyle {
  icon: React.ComponentType<{ className?: string }>;
  className: string;
}

const eventStyles: Record<string, EventStyle> = {
  run: { icon: WorkflowIcon, className: 'text-blue-900' },
  step: { icon: StepForwardIcon, className: 'text-green-900' },
  hook: { icon: WebhookIcon, className: 'text-yellow-900' },
  sleep: { icon: SleepIcon, className: 'text-gray-900' },
};

const defaultStyle: EventStyle = {
  icon: Circle,
  className: 'text-gray-900',
};

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
      <div className="hover:bg-gray-100 group-aria-selected:bg-gray-100 group-aria-selected:hover:bg-gray-200 hover:aria-selected:bg-gray-100 rounded-sm px-2 h-[34px] py-1.5 flex">
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
