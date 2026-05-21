'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';
import type { SegmentStatus, TimeMarker } from '../utils';
import {
  computeSpanGaps,
  computeSpanSegments,
  getSpanDurationMs,
  getResourceColor,
} from '../utils';

const SEGMENT_CONFIG: Record<
  SegmentStatus,
  { className?: string; style?: React.CSSProperties }
> = {
  queued: { className: 'bg-gray-400 border border-gray-500' },
  retrying: { className: 'box-border bg-gray-400 border border-gray-500' },
  waiting: { className: 'bg-gray-400 border border-gray-500' },
  running: { className: 'bg-blue-200 border border-blue-500' },
  failed: { className: 'bg-red-200 border border-red-500' },
  succeeded: { className: 'bg-green-200 border border-green-500' },
  sleeping: { className: 'bg-gray-400 border border-gray-500' },
  received: { className: 'bg-blue-200 border border-blue-500' },
};

const BAR_HEIGHT_PX = 24;
const TINY_BAR_BOX_SIZE_PX = 24;
const TINY_BAR_WIDTH_PX = 4;
const SEGMENT_GAP_PX = 1;
// Keep this in sync with the rendered row height in the timeline/event list.
const ROW_HEIGHT = 40;
const CONTAINER_PAD_Y = 8;
const END_CAP_HEIGHT = 8;
export const TIMELINE_PADDING_PX = 16;
const ORIGIN_MARKER_EPSILON = 0.000001;

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
  viewStart,
  viewDuration,
  containerWidth,
  isSelected,
  onClick,
}: {
  span: Span;
  viewStart: number;
  viewDuration: number;
  containerWidth: number;
  isSelected: boolean;
  onClick: () => void;
}): ReactNode {
  const startTime = getHighResInMs(span.startTime);
  const endTime = getHighResInMs(span.endTime);
  const totalDurationMs = getSpanDurationMs(span);

  const leftFracRaw =
    viewDuration > 0 ? (startTime - viewStart) / viewDuration : 0;
  const rightFracRaw =
    viewDuration > 0 ? (endTime - viewStart) / viewDuration : 0;
  const widthFrac = rightFracRaw - leftFracRaw;

  const leftPct = leftFracRaw * 100;
  const widthPct = widthFrac * 100;

  const pixelWidth = widthFrac * containerWidth;
  const visibleLeftFrac = Math.max(0, Math.min(1, leftFracRaw));
  const visibleRightFrac = Math.max(0, Math.min(1, rightFracRaw));
  const visiblePixelWidth =
    Math.max(0, visibleRightFrac - visibleLeftFrac) * containerWidth;
  const isTinyBar =
    containerWidth > 0 && visiblePixelWidth < TINY_BAR_BOX_SIZE_PX;
  const [isRowHovered, setIsRowHovered] = useState(false);

  const segments = useMemo(() => computeSpanSegments(span), [span]);

  const workflowStatus = (span.attributes.data as Record<string, unknown>)
    ?.status as string | undefined;
  const isErrored = span.status.code === 2 || workflowStatus === 'failed';
  const colors = getResourceColor(span.resource);
  const fallbackBg = isErrored
    ? (colors.errorBg ?? 'var(--ds-red-200)')
    : colors.bg;
  const fallbackBorder = isErrored
    ? (colors.errorBorder ?? 'var(--ds-red-500)')
    : colors.border;
  const renderDurationLabel = (label: string) => (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-start overflow-hidden px-1 text-[10px] font-mono font-medium leading-none whitespace-nowrap text-left text-gray-1000 tabular-nums">
      {label}
    </span>
  );
  const getMinDurationLabelWidthPx = (label: string) =>
    Math.max(40, label.length * 6 + 12);
  const totalDurationLabel = formatDuration(totalDurationMs);
  const showBarDurationLabel =
    isRowHovered &&
    pixelWidth >= getMinDurationLabelWidthPx(totalDurationLabel);

  const showBoundaryArrow = isTinyBar && (leftFracRaw < 0 || rightFracRaw > 1);
  const BoundaryArrow = leftFracRaw < 0.5 ? ArrowLeft : ArrowRight;
  const barContent = showBoundaryArrow ? (
    <div className="flex h-6 w-6 items-center justify-center rounded-[0.25rem]">
      <BoundaryArrow className="size-3 text-gray-900" />
    </div>
  ) : isTinyBar ? (
    <div
      className="h-6 rounded-[0.25rem] border"
      style={{ background: fallbackBg, borderColor: fallbackBorder }}
    />
  ) : segments.length > 0 ? (
    <div className="relative h-6 w-full">
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
            ? {
                background: 'var(--ds-gray-400)',
                borderColor: 'var(--ds-gray-500)',
              }
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
      className="relative h-6 rounded-[0.25rem] border"
      style={{
        width: '100%',
        minWidth: 4,
        background: fallbackBg,
        borderColor: fallbackBorder,
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
        'h-10 relative flex items-center hover:bg-gray-100 aria-selected:bg-gray-100 aria-selected:hover:bg-gray-200'
      )}
      onMouseEnter={() => setIsRowHovered(true)}
      onMouseLeave={() => setIsRowHovered(false)}
      onClick={onClick}
    >
      <div
        className="absolute inset-y-0"
        style={{
          left: TIMELINE_PADDING_PX,
          right: TIMELINE_PADDING_PX,
        }}
      >
        <div
          className="absolute top-1/2 -translate-y-1/2"
          style={{
            left: showBoundaryArrow
              ? `min(max(${leftPct}%, 0px), calc(100% - ${TINY_BAR_BOX_SIZE_PX}px))`
              : isTinyBar
                ? `min(${leftPct}%, calc(100% - ${TINY_BAR_WIDTH_PX}px))`
                : `${leftPct}%`,
            width: showBoundaryArrow
              ? `${TINY_BAR_BOX_SIZE_PX}px`
              : isTinyBar
                ? `${TINY_BAR_WIDTH_PX}px`
                : `max(${widthPct}%, 4px)`,
            height: BAR_HEIGHT_PX,
          }}
        >
          {barContent}
        </div>
      </div>
    </div>
  );
});

export { TimelineBar };

export function TimelineHeader({
  markers,
  hoverInfo,
}: {
  markers: TimeMarker[];
  hoverInfo?: { fraction: number; label: string } | null;
}): ReactNode {
  return (
    <div className="relative bg-background-100 border-b border-gray-alpha-400 h-10 min-h-10 flex items-end px-4 pb-1">
      <div className="relative h-full flex-1">
        {markers.map((m) => (
          <span
            key={`${m.position}-${m.label}`}
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
    </div>
  );
}

export function Timeline({
  spans,
  viewStart,
  viewEnd,
  markers,
  selectedId,
  onSelect,
  hoverFraction,
  altHeld = false,
}: {
  spans: Span[];
  viewStart: number;
  viewEnd: number;
  markers: TimeMarker[];
  selectedId: string | null;
  onSelect: (spanId: string) => void;
  hoverFraction?: number | null;
  altHeld?: boolean;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const viewDuration = viewEnd - viewStart;
  const timelineWidth = Math.max(0, containerWidth - TIMELINE_PADDING_PX * 2);

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
    () => computeSpanGaps(spans, viewStart, viewEnd),
    [spans, viewStart, viewEnd]
  );

  return (
    <div ref={containerRef} className="relative h-full overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-y-0 pointer-events-none"
        style={{
          left: TIMELINE_PADDING_PX,
          right: TIMELINE_PADDING_PX,
        }}
      >
        {markers.map((marker) =>
          Math.abs(marker.value) > ORIGIN_MARKER_EPSILON ? (
            <div
              key={`${marker.position}-${marker.label}`}
              className="absolute top-0 bottom-0 w-px bg-gray-alpha-300"
              style={{ left: `${marker.position * 100}%` }}
            />
          ) : null
        )}
      </div>
      {hoverFraction != null && (
        <div
          className="absolute inset-y-0 pointer-events-none z-10"
          style={{
            left: TIMELINE_PADDING_PX,
            right: TIMELINE_PADDING_PX,
          }}
        >
          <div
            className="absolute top-0 bottom-0 w-px bg-gray-alpha-500"
            style={{ left: `${hoverFraction * 100}%` }}
          />
        </div>
      )}
      {spans.map((span) => (
        <TimelineBar
          key={span.spanId}
          span={span}
          viewStart={viewStart}
          viewDuration={viewDuration}
          containerWidth={timelineWidth}
          isSelected={selectedId === span.spanId}
          onClick={() => onSelect(span.spanId)}
        />
      ))}
      {altHeld && (
        <div
          aria-hidden
          className="absolute inset-y-0 pointer-events-none"
          style={{
            left: TIMELINE_PADDING_PX,
            right: TIMELINE_PADDING_PX,
          }}
        >
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
