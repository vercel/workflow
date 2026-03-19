'use client';

import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { getHighResInMs } from '../../trace-viewer/util/timing';
import type { TimeCompression } from '../utils';
import {
  computeCompressedTimeMarkers,
  computeTimeMarkers,
  getResourceColor,
} from '../utils';

const QUEUED_BACKGROUND =
  'radial-gradient(circle at center, var(--ds-gray-800) 0 2.5px, transparent 2.6px) center / 52px 100% repeat-x, var(--ds-gray-300)';

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
  const activeStartTime = span.activeStartTime
    ? getHighResInMs(span.activeStartTime)
    : undefined;

  const leftFrac = compression.toVisual(startTime);
  const rightFrac = compression.toVisual(endTime);
  const widthFrac = rightFrac - leftFrac;

  const leftPct = leftFrac * 100;
  const widthPct = widthFrac * 100;

  const isErrored = span.status.code === 2;
  const colors = getResourceColor(span.resource);
  const barColor = isErrored
    ? (colors.errorBar ?? 'var(--ds-red-700)')
    : colors.bar;

  const hasQueued = activeStartTime != null && activeStartTime > startTime;

  let queuedBarPct = 0;
  let activeBarPct = 100;
  if (hasQueued && widthFrac > 0) {
    const activeFrac = compression.toVisual(activeStartTime);
    queuedBarPct = ((activeFrac - leftFrac) / widthFrac) * 100;
    activeBarPct = 100 - queuedBarPct;
  }

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
        className="absolute h-6 top-1.5 flex items-center rounded-sm"
        style={{
          left: `${leftPct}%`,
          width: `max(${widthPct}%, 4px)`,
        }}
      >
        {hasQueued ? (
          <div className="flex gap-0.5 w-full">
            <div
              className="h-4 rounded-[2px]"
              style={{
                width: `${queuedBarPct}%`,
                minWidth: 4,
                background: QUEUED_BACKGROUND,
              }}
            />
            <div
              className="h-4 rounded-[2px]"
              style={{
                width: `${activeBarPct}%`,
                minWidth: 4,
                background: barColor,
              }}
            />
          </div>
        ) : (
          <div
            className="h-4 rounded-[2px]"
            style={{
              width: '100%',
              minWidth: 4,
              background: barColor,
            }}
          />
        )}
      </div>
    </div>
  );
});

export { TimelineBar };

export function Timeline({
  spans,
  viewStart,
  viewDuration,
  rootStart,
  compression,
  isZoomed,
  onResetZoom,
  selectedId,
  onSelect,
}: {
  spans: Span[];
  viewStart: number;
  viewDuration: number;
  rootStart: number;
  compression: TimeCompression;
  isZoomed: boolean;
  onResetZoom: () => void;
  selectedId: string | null;
  onSelect: (spanId: string) => void;
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
    <>
      <div className="sticky top-0 z-[4] bg-background-100 border-b border-gray-alpha-400 h-8 min-h-8 flex items-end px-4 pb-1">
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
    </>
  );
}
