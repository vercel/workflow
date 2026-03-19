import { cva } from 'class-variance-authority';
import { memo, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { SegmentStatus } from '../../trace-viewer/components/span-segments';
import type { ResourceType } from '../../trace-viewer/components/span-strategies';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';

const MIN_BAR_WIDTH_PCT = 0.8;

export interface TimelineCompression {
  toVisual: (time: number) => number;
}

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

const toResourceType = (resource: string): ResourceType => {
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

const TimelineRow = ({
  children,
  isSelected,
  onClick,
  title,
}: {
  children: ReactNode;
  isSelected: boolean;
  onClick: () => void;
  title: string;
}) => {
  return (
    <button
      type="button"
      title={title}
      className="overflow-clip w-full px-2 group block cursor-pointer"
      role="treeitem"
      aria-selected={isSelected}
      onClick={onClick}
    >
      <div
        className={cn(
          'relative flex h-9 items-center hover:bg-gray-100 rounded-sm px-2 group-aria-selected:bg-gray-100 group-aria-selected:hover:bg-gray-200'
        )}
      >
        {children}
      </div>
    </button>
  );
};

export const resourceStatus = cva('', {
  variants: {
    resourceType: {
      run: 'bg-blue-200 text-blue-900',
      step: 'bg-green-200 text-green-900',
      hook: 'bg-amber-200 text-amber-900',
      sleep: 'bg-purple-200 text-purple-900',
      default: 'bg-gray-200 text-gray-900',
    },
    errored: {
      true: 'bg-red-200 text-red-900',
      false: '',
    },
  },
  defaultVariants: {
    resourceType: 'default',
  },
});

const spanVariants = cva('relative block h-full w-full min-w-0.5 rounded-xs', {
  variants: {
    status: {
      running: 'bg-green-700',
      failed: 'bg-red-700',
      succeeded: 'bg-blue-700',
      retrying: 'bg-yellow-700',
      queued: 'bg-gray-500',
      waiting: 'bg-gray-700',
      sleeping: 'bg-amber-700',
      received: 'bg-blue-700',
    },
    errored: {
      true: 'bg-red-700',
      false: '',
    },
    resourceType: {
      run: 'bg-blue-700',
      step: 'bg-green-700',
      hook: 'bg-amber-700',
      sleep: 'bg-purple-700',
      default: 'bg-gray-500',
    },
  },
});

export const TimelineBar = memo(function TimelineBar({
  span,
  compression,
  isSelected,
  onClick,
}: {
  span: Span;
  compression: TimelineCompression;
  isSelected: boolean;
  onClick: () => void;
}): ReactNode {
  const startTime = getHighResInMs(span.startTime);
  const endTime = getHighResInMs(span.endTime);
  const activeStartTime = span.activeStartTime
    ? getHighResInMs(span.activeStartTime)
    : undefined;

  const leftFrac = compression.toVisual(startTime);
  const rightFrac = compression.toVisual(endTime);
  const widthFrac = Math.max(rightFrac - leftFrac, 0);

  const leftPct = clamp(leftFrac * 100, 0, 100);
  const maxWidthPct = Math.max(100 - leftPct, MIN_BAR_WIDTH_PCT);
  const widthPct =
    widthFrac > 0
      ? clamp(widthFrac * 100, MIN_BAR_WIDTH_PCT, maxWidthPct)
      : MIN_BAR_WIDTH_PCT;

  const hasQueued =
    activeStartTime != null &&
    activeStartTime > startTime &&
    activeStartTime < endTime;

  let queuedBarPct = 0;
  let activeBarPct = 100;
  if (hasQueued && widthFrac > 0) {
    const activeFrac = compression.toVisual(activeStartTime);
    queuedBarPct = clamp(((activeFrac - leftFrac) / widthFrac) * 100, 0, 100);
    activeBarPct = 100 - queuedBarPct;
  }

  const isErrored = span.status.code === 2;
  const activeStatus: SegmentStatus = isErrored ? 'failed' : 'running';
  const durationLabel = formatDuration(Math.max(endTime - startTime, 0), true);

  return (
    <TimelineRow
      isSelected={isSelected}
      onClick={onClick}
      title={`${span.name} - ${durationLabel}`}
    >
      <div
        className="absolute top-2 h-5 min-w-0.5"
        style={{
          left: `${leftPct}%`,
          width: `${widthPct}%`,
        }}
      >
        <div className="flex h-full w-full overflow-hidden rounded-xs ring-1 ring-black/5">
          {hasQueued && queuedBarPct > 0 ? (
            <Span status="queued" resourceType="default" width={queuedBarPct} />
          ) : null}
          <Span
            status={activeStatus}
            resourceType={toResourceType(span.resource)}
            width={activeBarPct}
          />
        </div>
      </div>
    </TimelineRow>
  );
});

const Span = ({
  status,
  resourceType,
  width,
}: {
  status: SegmentStatus;
  resourceType: ResourceType;
  width: number;
}) => {
  return (
    <span
      style={{
        width: `${clamp(width, 0, 100)}%`,
      }}
      className="block h-full"
    >
      <span className={cn(spanVariants({ status, resourceType }))} />
    </span>
  );
};

export const Timeline = memo(function Timeline({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <div className="w-full h-full py-2">{children}</div>;
});
