import { cva } from 'class-variance-authority';
import { StepForward } from 'lucide-react';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';

const eventTag = cva(['rounded-sm p-1'], {
  variants: {
    eventType: {
      run: 'bg-blue-200 text-blue-900',
      step: 'bg-green-200 text-green-900',
      hook: 'bg-yellow-200 text-yellow-900',
      sleep: 'bg-gray-200 text-gray-900',
      default: 'bg-gray-200 text-gray-900',
    },
  },
});

type EventType = 'run' | 'step' | 'hook' | 'sleep' | 'default';

const toEventType = (resource: string): EventType => {
  switch (resource) {
    case 'run':
    case 'step':
    case 'hook':
    case 'sleep':
      return resource;
    default:
      return 'default';
  }
};

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
          <span className={eventTag({ eventType: toEventType(span.resource) })}>
            <StepForward className="w-4 h-4" />
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
