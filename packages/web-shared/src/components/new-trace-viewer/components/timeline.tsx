'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import type { Span } from '../../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../../trace-viewer/util/timing';
import type { Segment, SegmentStatus, TimeMarker } from '../utils';
import {
  computeSpanGaps,
  computeSpanSegments,
  getResourceColor,
  getSpanDurationMs,
} from '../utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TINY_BAR_BOX_SIZE_PX = 24;
const TINY_BAR_WIDTH_PX = 4;
export const TIMELINE_PADDING_PX = 16;

const SEGMENT_CLASSES: Record<SegmentStatus, string> = {
  queued: 'bg-gray-400 border border-gray-500',
  retrying: 'bg-gray-400 border border-gray-500',
  waiting: 'bg-gray-400 border border-gray-500',
  running: 'bg-blue-200 border border-blue-500',
  failed: 'bg-red-200 border border-red-500',
  succeeded: 'bg-green-200 border border-green-500',
  sleeping: 'bg-gray-400 border border-gray-500',
  received: 'bg-blue-200 border border-blue-500',
};

const TIMELINE_INSET_STYLE: CSSProperties = {
  left: TIMELINE_PADDING_PX,
  right: TIMELINE_PADDING_PX,
};

// ---------------------------------------------------------------------------
// Bar geometry
// ---------------------------------------------------------------------------

type BarMode =
  | { kind: 'arrow'; direction: 'left' | 'right' }
  | { kind: 'tiny' }
  | { kind: 'full' };

interface BarGeometry {
  mode: BarMode;
  leftPct: number;
  widthPct: number;
  visibleStartMs: number;
  visibleEndMs: number;
  visiblePixelWidth: number;
}

/**
 * Compute the bar's geometry inside the timeline viewport. Percentages are
 * always in [0, 100] so we never emit CSS values that exceed browser layout
 * limits at extreme zoom.
 */
function computeBarGeometry(
  startMs: number,
  endMs: number,
  viewStart: number,
  viewEnd: number,
  containerWidth: number
): BarGeometry {
  const viewDuration = viewEnd - viewStart;
  const visibleStartMs = Math.max(startMs, viewStart);
  const visibleEndMs = Math.min(endMs, viewEnd);
  const visibleDurationMs = Math.max(0, visibleEndMs - visibleStartMs);
  const widthFrac = viewDuration > 0 ? visibleDurationMs / viewDuration : 0;
  const visiblePixelWidth = widthFrac * containerWidth;

  const isTiny = containerWidth > 0 && visiblePixelWidth < TINY_BAR_BOX_SIZE_PX;
  const extendsOffLeft = startMs < viewStart;
  const extendsOffRight = endMs > viewEnd;

  const mode: BarMode =
    isTiny && (extendsOffLeft || extendsOffRight)
      ? { kind: 'arrow', direction: extendsOffRight ? 'right' : 'left' }
      : isTiny
        ? { kind: 'tiny' }
        : { kind: 'full' };

  return {
    mode,
    leftPct:
      viewDuration > 0
        ? ((visibleStartMs - viewStart) / viewDuration) * 100
        : 0,
    widthPct: widthFrac * 100,
    visibleStartMs,
    visibleEndMs,
    visiblePixelWidth,
  };
}

function getBarPositionStyle(geometry: BarGeometry): {
  left: string;
  width: string;
} {
  switch (geometry.mode.kind) {
    case 'arrow':
      return {
        left:
          geometry.mode.direction === 'right'
            ? `calc(100% - ${TINY_BAR_BOX_SIZE_PX}px)`
            : '0px',
        width: `${TINY_BAR_BOX_SIZE_PX}px`,
      };
    case 'tiny':
      return {
        left: `min(${geometry.leftPct}%, calc(100% - ${TINY_BAR_WIDTH_PX}px))`,
        width: `${TINY_BAR_WIDTH_PX}px`,
      };
    case 'full':
      return {
        left: `${geometry.leftPct}%`,
        width: `max(${geometry.widthPct}%, 4px)`,
      };
  }
}

// ---------------------------------------------------------------------------
// Segment projection
// ---------------------------------------------------------------------------

interface VisibleSegment {
  status: SegmentStatus;
  leftPct: number;
  widthPct: number;
  pixelWidth: number;
  fullDurationMs: number;
}

/**
 * Project status segments onto the visible portion of a bar. Segments fully
 * outside the visible window are dropped; segments crossing the edge are
 * clipped to [0%, 100%] of the visible bar.
 */
function projectSegments(
  segments: Segment[],
  spanStartMs: number,
  spanDurationMs: number,
  geometry: BarGeometry
): VisibleSegment[] {
  const visibleDurationMs = geometry.visibleEndMs - geometry.visibleStartMs;
  if (visibleDurationMs <= 0) return [];

  return segments.flatMap((seg) => {
    const segStartMs = spanStartMs + seg.startFraction * spanDurationMs;
    const segEndMs = spanStartMs + seg.endFraction * spanDurationMs;
    const startMs = Math.max(segStartMs, geometry.visibleStartMs);
    const endMs = Math.min(segEndMs, geometry.visibleEndMs);
    if (endMs <= startMs) return [];

    const widthFrac = (endMs - startMs) / visibleDurationMs;
    return [
      {
        status: seg.status,
        leftPct:
          ((startMs - geometry.visibleStartMs) / visibleDurationMs) * 100,
        widthPct: widthFrac * 100,
        pixelWidth: widthFrac * geometry.visiblePixelWidth,
        fullDurationMs: (seg.endFraction - seg.startFraction) * spanDurationMs,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function DurationLabel({ label }: { label: string }): ReactNode {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-start overflow-hidden px-1 text-[10px] font-mono font-medium leading-none whitespace-nowrap text-left text-gray-1000 tabular-nums opacity-0 group-hover/timeline-row:opacity-100">
      {label}
    </span>
  );
}

function BoundaryArrow({
  direction,
}: {
  direction: 'left' | 'right';
}): ReactNode {
  const Icon = direction === 'right' ? ArrowRight : ArrowLeft;
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-[0.25rem]">
      <Icon className="size-3 text-gray-900" />
    </div>
  );
}

function PlainBar({
  bg,
  border,
  label,
}: {
  bg: string;
  border: string;
  label: string | null;
}): ReactNode {
  return (
    <div
      className="relative h-6 w-full min-w-1 rounded-[0.25rem] border"
      style={{ background: bg, borderColor: border }}
    >
      {label ? <DurationLabel label={label} /> : null}
    </div>
  );
}

function SegmentBar({ segments }: { segments: VisibleSegment[] }): ReactNode {
  return (
    <div className="relative h-6 w-full">
      {segments.map((seg, i) => {
        const label = formatDuration(seg.fullDurationMs);
        // Only render the label when there's enough room for it without clipping.
        const showLabel = seg.pixelWidth >= Math.max(40, label.length * 6 + 12);
        // Beef up the queued segment when it's too narrow to read.
        const isNarrowQueued = seg.status === 'queued' && seg.pixelWidth < 20;
        const overrideBg = isNarrowQueued ? 'var(--ds-gray-400)' : undefined;
        const overrideBorder = isNarrowQueued
          ? 'var(--ds-gray-500)'
          : undefined;

        return (
          <div
            key={`${seg.status}-${i}`}
            className={cn(
              'absolute h-full rounded-[0.25rem]',
              SEGMENT_CLASSES[seg.status]
            )}
            style={{
              // 1px gap between adjacent segments, distributed equally.
              left: `calc(${seg.leftPct}% + 0.5px)`,
              width: `calc(${seg.widthPct}% - 1px)`,
              minWidth: 1,
              background: overrideBg,
              borderColor: overrideBorder,
            }}
          >
            {showLabel ? <DurationLabel label={label} /> : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineBar
// ---------------------------------------------------------------------------

const TimelineBar = memo(function TimelineBar({
  span,
  viewStart,
  viewDuration,
  containerWidth,
  isSelected,
  onSelect,
}: {
  span: Span;
  viewStart: number;
  viewDuration: number;
  containerWidth: number;
  isSelected: boolean;
  onSelect: (spanId: string) => void;
}): ReactNode {
  const startMs = getHighResInMs(span.startTime);
  const endMs = getHighResInMs(span.endTime);
  const totalDurationMs = getSpanDurationMs(span);

  const geometry = useMemo(
    () =>
      computeBarGeometry(
        startMs,
        endMs,
        viewStart,
        viewStart + viewDuration,
        containerWidth
      ),
    [startMs, endMs, viewStart, viewDuration, containerWidth]
  );

  const baseSegments = useMemo(() => computeSpanSegments(span), [span]);
  const segments = useMemo(
    () =>
      geometry.mode.kind === 'full'
        ? projectSegments(baseSegments, startMs, totalDurationMs, geometry)
        : [],
    [geometry, baseSegments, startMs, totalDurationMs]
  );

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

  const totalLabel = formatDuration(totalDurationMs);
  const showTotalLabel =
    geometry.visiblePixelWidth >= Math.max(40, totalLabel.length * 6 + 12);

  const handleClick = useCallback(() => {
    onSelect(span.spanId);
  }, [onSelect, span.spanId]);

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      className="group/timeline-row h-10 relative flex items-center hover:bg-gray-100 aria-selected:bg-gray-100 aria-selected:hover:bg-gray-200"
      onClick={handleClick}
    >
      <div className="absolute inset-y-0" style={TIMELINE_INSET_STYLE}>
        <div
          className="absolute top-1/2 h-6 -translate-y-1/2"
          style={getBarPositionStyle(geometry)}
        >
          {geometry.mode.kind === 'arrow' ? (
            <BoundaryArrow direction={geometry.mode.direction} />
          ) : geometry.mode.kind === 'tiny' ? (
            <div
              className="h-6 rounded-[0.25rem] border"
              style={{ background: fallbackBg, borderColor: fallbackBorder }}
            />
          ) : segments.length > 0 ? (
            <SegmentBar segments={segments} />
          ) : (
            <PlainBar
              bg={fallbackBg}
              border={fallbackBorder}
              label={showTotalLabel ? totalLabel : null}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export { TimelineBar };

// ---------------------------------------------------------------------------
// DeltaIndicator (Alt-key gap overlay)
// ---------------------------------------------------------------------------

// Row and indicator sizes are local to DeltaIndicator since it's the only
// place that needs to compute Y positions from a row index. ROW_HEIGHT must
// match the `h-10` (40px) row used in TimelineBar.
const DELTA_ROW_HEIGHT_PX = 40;
const DELTA_CAP_HEIGHT_PX = 8;
// Vertical offset to sit the indicator inside the gap between row N and N+1,
// aligned with where the bar starts in the next row (rows center a 24px bar
// inside 40px, so bars start ~8px from the top of the row).
const DELTA_ROW_OFFSET_PX = 8;

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
  const centerY = DELTA_ROW_OFFSET_PX + (rowIndex + 1) * DELTA_ROW_HEIGHT_PX;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${leftFrac * 100}%`,
        width: `${(rightFrac - leftFrac) * 100}%`,
        top: centerY - DELTA_CAP_HEIGHT_PX / 2,
        height: DELTA_CAP_HEIGHT_PX,
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

// ---------------------------------------------------------------------------
// TimelineHeader
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

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
        style={TIMELINE_INSET_STYLE}
      >
        {markers.map((marker) =>
          // Skip the "0s" origin marker since the left edge already implies it.
          Math.abs(marker.value) > 0.000001 ? (
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
          style={TIMELINE_INSET_STYLE}
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
          onSelect={onSelect}
        />
      ))}
      {altHeld && (
        <div
          aria-hidden
          className="absolute inset-y-0 pointer-events-none"
          style={TIMELINE_INSET_STYLE}
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
