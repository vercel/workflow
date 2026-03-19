import { StepForward } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { Span } from '../../trace-viewer/types';
import { formatDuration } from '../../../lib/utils';

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

const EventRow = ({ span }: { span: Span }) => {
  return (
    <li
      key={span.spanId}
      role="treeitem"
      aria-level={0}
      aria-selected={false}
      aria-expanded="false"
      className="overflow-clip group"
      // onClick={() => {
      //   setActiveSpan(span.spanId);
      //   console.log(span.spanId);
      // }}
    >
      <div className="hover:bg-gray-100 group-aria-selected:bg-gray-100 group-aria-selected:hover:bg-gray-200 hover:aria-selected:bg-gray-100 rounded-sm px-2 h-9 py-1.5 cursor-pointer flex">
        <div className="flex items-center gap-2">
          <span className={eventTag({ eventType: toEventType(span.resource) })}>
            <StepForward className="w-4 h-4" />
          </span>
          <span className="text-label-14">{span.name}</span>
        </div>
        <div className="ml-auto">
          <span className="text-label-14 text-gray-900 tabular-nums">
            {formatDuration(span.duration[1])}
          </span>
        </div>
      </div>
    </li>
  );
};

const EventList = ({ spans }: { spans: Span[] }) => {
  return (
    <ul
      id="event-list"
      role="tree"
      className="block min-h-0 overflow-visible px-2 py-2"
    >
      {spans.map((span) => {
        return <EventRow key={span.spanId} span={span} />;
      })}
    </ul>
  );
};

export default EventList;
