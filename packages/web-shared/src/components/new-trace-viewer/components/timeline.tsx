'use client';

import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { getHighResInMs } from '../../trace-viewer/util/timing';
import type { SegmentStatus, TimeCompression } from '../utils';
import {
  computeCompressedTimeMarkers,
  computeSpanSegments,
  computeTimeMarkers,
  getResourceColor,
} from '../utils';

const SEGMENT_CLASSES: Record<SegmentStatus, string> = {
  queued: 'segment-queued',
  retrying: 'segment-hatched',
  waiting: 'segment-hatched',
  running: 'bg-blue-700',
  failed: 'bg-red-700',
  succeeded: 'bg-green-700',
  sleeping: 'bg-amber-700',
  received: 'bg-blue-700',
};

const TimelineBar = memo(function TimelineBar({
  span,
  compression,
  isSelected,
  onClick,
}: {
  span: Span;
  compression: TimeCompression;
  isSelected: boolean;
  onClick: () => void;
}): ReactNode {
  const startTime = getHighResInMs(span.startTime);
  const endTime = getHighResInMs(span.endTime);

  const leftFrac = compression.toVisual(startTime);
  const rightFrac = compression.toVisual(endTime);
  const widthFrac = rightFrac - leftFrac;

  const leftPct = leftFrac * 100;
  const widthPct = widthFrac * 100;

  const segments = useMemo(() => computeSpanSegments(span), [span]);

  const isErrored = span.status.code === 2;
  const colors = getResourceColor(span.resource);
  const fallbackColor = isErrored
    ? (colors.errorBar ?? 'var(--ds-red-700)')
    : colors.bar;

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      className={cn(
        'h-9 relative flex items-center hover:bg-gray-100 aria-selected:bg-gray-100 rounded-sm aria-selected:hover:bg-gray-200'
      )}
      onClick={onClick}
    >
      <div
        className="absolute h-6 top-1.5 rounded-sm"
        style={{
          left: `${leftPct}%`,
          width: `max(${widthPct}%, 4px)`,
        }}
      >
        {segments.length > 0 ? (
          <div className="relative w-full h-4 top-1 [&>*:nth-child(2)]:rounded-l-sm">
            {segments.map((seg, i) => (
              <div
                key={`${seg.status}-${i}`}
                className={cn(
                  'absolute h-full first:rounded-sm last:rounded-r-sm border-r border-white',
                  SEGMENT_CLASSES[seg.status]
                )}
                style={{
                  left: `${seg.startFraction * 100}%`,
                  width: `${(seg.endFraction - seg.startFraction) * 100}%`,
                  minWidth: 2,
                }}
              />
            ))}
          </div>
        ) : (
          <div
            className="h-4 rounded-sm relative top-1"
            style={{
              width: '100%',
              minWidth: 4,
              background: fallbackColor,
            }}
          />
        )}
      </div>
    </div>
  );
});

export { TimelineBar };

export function TimelineHeader({
  viewStart,
  viewDuration,
  rootStart,
  compression,
  isZoomed,
  onResetZoom,
}: {
  viewStart: number;
  viewDuration: number;
  rootStart: number;
  compression: TimeCompression;
  isZoomed: boolean;
  onResetZoom: () => void;
}): ReactNode {
  const viewEnd = viewStart + viewDuration;

  const markers = useMemo(
    () =>
      compression.isCompressed
        ? computeCompressedTimeMarkers(
            compression,
            viewStart,
            viewEnd,
            rootStart
          )
        : computeTimeMarkers(viewDuration, viewStart - rootStart),
    [compression, viewStart, viewEnd, viewDuration, rootStart]
  );

  return (
    <div className="relative bg-background-100 border-b border-gray-alpha-400 h-8 min-h-8 flex items-end px-4 pb-1">
      {markers.map((m, i) => (
        <span
          key={i}
          className="absolute bottom-1 font-mono text-xs font-normal leading-4 text-gray-900 whitespace-nowrap -translate-x-1/2"
          style={{ left: `${m.position * 100}%` }}
        >
          {m.label}
        </span>
      ))}
      {isZoomed && (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 z-[5] flex items-center py-0.5 px-2 border border-gray-alpha-400 rounded-md bg-background-100 font-sans text-[11px] font-medium text-gray-900 cursor-pointer whitespace-nowrap transition-[color,border-color] duration-[120ms] ease-in-out hover:text-gray-1000 hover:border-gray-600"
          onClick={onResetZoom}
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}

export function Timeline({
  spans,
  compression,
  selectedId,
  onSelect,
}: {
  spans: Span[];
  compression: TimeCompression;
  selectedId: string | null;
  onSelect: (spanId: string) => void;
}): ReactNode {
  return (
    <div className="relative py-2">
      {spans.map((span) => (
        <TimelineBar
          key={span.spanId}
          span={span}
          compression={compression}
          isSelected={selectedId === span.spanId}
          onClick={() => onSelect(span.spanId)}
        />
      ))}
    </div>
  );
}
