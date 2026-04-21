'use client';

import type { ReactNode } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';
import type { SegmentStatus, TimeCompression } from '../utils';
import {
  computeCompressedTimeMarkers,
  computeSpanGaps,
  computeSpanSegments,
  computeTimeMarkers,
  getResourceColor,
} from '../utils';

const QUEUED_BACKGROUND =
  'radial-gradient(circle, var(--ds-gray-400) 2px, transparent 2px) center / 20px 20px space no-repeat, var(--ds-gray-500)';

const HATCHED_BACKGROUND =
  'repeating-linear-gradient(-45deg, var(--ds-gray-400) 0px, var(--ds-gray-400) 3px, var(--ds-gray-500) 3px, var(--ds-gray-500) 6px)';

const SEGMENT_CONFIG: Record<
  SegmentStatus,
  { className?: string; style?: React.CSSProperties }
> = {
  queued: { style: { background: QUEUED_BACKGROUND } },
  retrying: {
    className: 'box-border bg-gray-500',
  },
  waiting: { style: { background: HATCHED_BACKGROUND } },
  running: { className: 'bg-blue-700' },
  failed: { className: 'bg-red-700' },
  succeeded: { className: 'bg-green-700' },
  sleeping: { className: 'bg-amber-700' },
  received: { className: 'bg-blue-700' },
};

const FIXED_BAR_WIDTH_PX = 4;
const SEGMENT_GAP_PX = 1;
// Keep this in sync with the rendered row height in the timeline/event list.
const ROW_HEIGHT = 34;
const CONTAINER_PAD_Y = 8;
const END_CAP_HEIGHT = 8;

const DeltaIndicator = memo(function DeltaIndicator({
  leftFrac,
  rightFrac,
  label,
  rowIndex,
}: {
  leftFrac: number;
  rightFrac: number;
  label: string;
  rowIndex: number;
}) {
  const centerY = CONTAINER_PAD_Y + (rowIndex + 1) * ROW_HEIGHT;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${leftFrac * 100}%`,
        width: `${(rightFrac - leftFrac) * 100}%`,
        top: centerY - END_CAP_HEIGHT / 2,
        height: END_CAP_HEIGHT,
      }}
    >
      <div className="absolute left-0 top-0 w-px h-full bg-amber-800" />
      <div className="absolute left-0 right-0 top-1/2 h-px bg-amber-800" />
      <div className="absolute right-0 top-0 w-px h-full bg-amber-800" />
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-label-12 leading-none whitespace-nowrap rounded-xs px-1 py-0.5 text-gray-100 bg-amber-800">
        {label}
      </span>
    </div>
  );
});

const TimelineBar = memo(function TimelineBar({
  span,
  compression,
  containerWidth,
  isSelected,
  onClick,
}: {
  span: Span;
  compression: TimeCompression;
  containerWidth: number;
  isSelected: boolean;
  onClick: () => void;
}): ReactNode {
  const startTime = getHighResInMs(span.startTime);
  const endTime = getHighResInMs(span.endTime);
  const totalDurationMs = endTime - startTime;

  const leftFrac = compression.toVisual(startTime);
  const rightFrac = compression.toVisual(endTime);
  const widthFrac = rightFrac - leftFrac;

  const leftPct = leftFrac * 100;
  const widthPct = widthFrac * 100;

  const pixelWidth = widthFrac * containerWidth;
  const isCompressed = containerWidth > 0 && pixelWidth < FIXED_BAR_WIDTH_PX;
  const [isRowHovered, setIsRowHovered] = useState(false);

  const segments = useMemo(() => computeSpanSegments(span), [span]);
  const finalSegment = segments[segments.length - 1];

  const workflowStatus = (span.attributes.data as Record<string, unknown>)
    ?.status as string | undefined;
  const isErrored = span.status.code === 2 || workflowStatus === 'failed';
  const colors = getResourceColor(span.resource);
  const fallbackColor = isErrored
    ? (colors.errorBar ?? 'var(--ds-red-700)')
    : colors.bar;
  const compressedSegmentStatus = isErrored
    ? 'failed'
    : span.resource === 'hook'
      ? 'received'
      : finalSegment?.status;
  const compressedSegmentStyle =
    compressedSegmentStatus === 'queued'
      ? { background: 'var(--ds-gray-500)' }
      : compressedSegmentStatus
        ? SEGMENT_CONFIG[compressedSegmentStatus].style
        : undefined;
  const compressedSegmentClassName = compressedSegmentStatus
    ? SEGMENT_CONFIG[compressedSegmentStatus].className
    : undefined;

  const hasCompressedStatus = Boolean(
    compressedSegmentClassName || compressedSegmentStyle
  );
  const renderDurationLabel = (label: string) => (
    <span
      className="pointer-events-none absolute inset-0 flex items-center justify-start overflow-hidden px-1 text-[10px] font-mono font-medium leading-none whitespace-nowrap text-left text-white tabular-nums"
      style={{ textShadow: '0 1px 1px rgba(0, 0, 0, 0.45)' }}
    >
      {label}
    </span>
  );
  const getMinDurationLabelWidthPx = (label: string) =>
    Math.max(40, label.length * 6 + 12);
  const totalDurationLabel = formatDuration(totalDurationMs);
  const showBarDurationLabel =
    isRowHovered &&
    pixelWidth >= getMinDurationLabelWidthPx(totalDurationLabel);

  const barContent = isCompressed ? (
    <div
      className={cn(
        'relative h-4 rounded-[0.25rem] top-[3px]',
        compressedSegmentClassName
      )}
      style={{
        width: '100%',
        background: hasCompressedStatus ? undefined : fallbackColor,
        ...compressedSegmentStyle,
      }}
    >
      {showBarDurationLabel ? renderDurationLabel(totalDurationLabel) : null}
    </div>
  ) : segments.length > 0 ? (
    <div className="relative w-full h-4 top-[3px]">
      {segments.map((seg, i) => {
        const segPixelWidth =
          (seg.endFraction - seg.startFraction) * pixelWidth;
        const segDurationLabel = formatDuration(
          (seg.endFraction - seg.startFraction) * totalDurationMs
        );
        const showSegmentDurationLabel =
          isRowHovered &&
          segPixelWidth >= getMinDurationLabelWidthPx(segDurationLabel);
        const segStyle =
          seg.status === 'queued' && segPixelWidth < 20
            ? { background: 'var(--ds-gray-500)' }
            : SEGMENT_CONFIG[seg.status].style;

        return (
          <div
            key={`${seg.status}-${i}`}
            className={cn(
              'absolute h-full rounded-[0.25rem]',
              SEGMENT_CONFIG[seg.status].className
            )}
            style={{
              left: `calc(${seg.startFraction * 100}% + ${SEGMENT_GAP_PX / 2}px)`,
              width: `calc(${(seg.endFraction - seg.startFraction) * 100}% - ${SEGMENT_GAP_PX}px)`,
              minWidth: 1,
              ...segStyle,
            }}
          >
            {showSegmentDurationLabel
              ? renderDurationLabel(segDurationLabel)
              : null}
          </div>
        );
      })}
    </div>
  ) : (
    <div
      className="relative h-4 rounded-[0.25rem] top-[3px]"
      style={{
        width: '100%',
        minWidth: 4,
        background: fallbackColor,
      }}
    >
      {showBarDurationLabel ? renderDurationLabel(totalDurationLabel) : null}
    </div>
  );

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      className={cn(
        'h-[34px] relative flex items-center hover:bg-gray-100 aria-selected:bg-gray-100 rounded-sm aria-selected:hover:bg-gray-200'
      )}
      onMouseEnter={() => setIsRowHovered(true)}
      onMouseLeave={() => setIsRowHovered(false)}
      onClick={onClick}
    >
      <div
        className="absolute top-1.5 h-[22px] rounded-sm"
        style={{
          left: isCompressed
            ? `min(${leftPct}%, calc(100% - ${FIXED_BAR_WIDTH_PX}px))`
            : `${leftPct}%`,
          width: isCompressed
            ? `${FIXED_BAR_WIDTH_PX}px`
            : `max(${widthPct}%, 4px)`,
        }}
      >
        {barContent}
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
  hoverInfo,
}: {
  viewStart: number;
  viewDuration: number;
  rootStart: number;
  compression: TimeCompression;
  isZoomed: boolean;
  onResetZoom: () => void;
  hoverInfo?: { fraction: number; label: string } | null;
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
    <div className="relative bg-background-100 border-b border-gray-alpha-400 h-10 min-h-10 flex items-end px-2 pb-1">
      <div className="relative h-full flex-1">
        {markers.map((m, i) => (
          <span
            key={i}
            className="absolute bottom-1 font-mono text-xs font-normal leading-4 text-gray-900 whitespace-nowrap"
            style={{ left: `${m.position * 100}%` }}
          >
            {m.label}
          </span>
        ))}
        {hoverInfo && (
          <span
            className="absolute top-1 pointer-events-none z-10 font-mono text-[11px] leading-4 text-gray-1000 whitespace-nowrap bg-background-100 border border-gray-alpha-400 rounded px-1 -translate-x-1/2"
            style={{ left: `${hoverInfo.fraction * 100}%` }}
          >
            {hoverInfo.label}
          </span>
        )}
      </div>
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
  hoverFraction,
  altHeld = false,
}: {
  spans: Span[];
  compression: TimeCompression;
  selectedId: string | null;
  onSelect: (spanId: string) => void;
  hoverFraction?: number | null;
  altHeld?: boolean;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const gaps = useMemo(
    () => computeSpanGaps(spans, compression),
    [spans, compression]
  );

  return (
    <div ref={containerRef} className="relative py-2">
      {hoverFraction != null && (
        <div
          className="absolute top-0 bottom-0 w-px bg-gray-alpha-400 pointer-events-none z-10"
          style={{ left: `${hoverFraction * 100}%` }}
        />
      )}
      {spans.map((span) => (
        <TimelineBar
          key={span.spanId}
          span={span}
          compression={compression}
          containerWidth={containerWidth}
          isSelected={selectedId === span.spanId}
          onClick={() => onSelect(span.spanId)}
        />
      ))}
      {altHeld && (
        <div aria-hidden className="absolute inset-0 pointer-events-none">
          {gaps.map((gap) => (
            <DeltaIndicator
              key={gap.rowIndex}
              leftFrac={gap.leftFrac}
              rightFrac={gap.rightFrac}
              label={formatDuration(gap.gapMs, true)}
              rowIndex={gap.rowIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
}
