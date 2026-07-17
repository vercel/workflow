'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn';
import {
  formatDurationPrecise,
  getHighResInMs,
} from '../../trace-viewer/util/timing';
import { isSpanDimmedBySearch, type SpanSearchResult } from '../search';
import type { Span } from '../types';
import type {
  OffscreenMarkers,
  Segment,
  SegmentStatus,
  SpanDelta,
  TimeMarker,
} from '../utils';
import {
  computeOffscreenMarkers,
  computeSpanDelta,
  computeSpanGaps,
  computeSpanMarkers,
  computeSpanSegments,
  getResourceColor,
  getSpanDurationMs,
  isSpanErrored,
} from '../utils';
import {
  cullCollidingMarkers,
  MarkerLayer,
  OffscreenMarkerIndicator,
  projectMarkers,
} from './span-markers';
import styles from './timeline.module.css';
import { ROW_HEIGHT_PX, useRowWindow } from './use-row-window';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TINY_BAR_BOX_SIZE_PX = 24;
const TINY_BAR_WIDTH_PX = 4;
export const TIMELINE_PADDING_PX = 16;

const SEGMENT_CLASSES: Record<SegmentStatus, string> = {
  queued: 'bg-gray-400 border border-gray-500',
  pending: 'bg-gray-200 border border-gray-500',
  retrying: 'bg-gray-400 border border-gray-500',
  waiting: 'bg-gray-200 border border-gray-500',
  running: 'bg-blue-200 border border-blue-500',
  completed: 'bg-blue-200 border border-blue-500',
  failed: 'bg-red-200 border border-red-500',
  succeeded: 'bg-green-200 border border-green-500',
  sleeping: 'bg-gray-400 border border-gray-500',
  received: 'bg-blue-200 border border-blue-500',
};

const TIMELINE_INSET_STYLE: CSSProperties = {
  left: TIMELINE_PADDING_PX,
  right: TIMELINE_PADDING_PX,
};

const STRIPED_SEGMENT_STATUSES: ReadonlySet<SegmentStatus> = new Set([
  'pending',
  'running',
  'received',
]);

function AnimatedStripes({ status }: { status: SegmentStatus }): ReactNode {
  return (
    <div
      aria-hidden
      className={
        status === 'pending' ? styles.pendingStripes : styles.runningStripes
      }
    />
  );
}

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

/** Estimated rendered width of a 10px-mono duration label (6px/glyph + padding). */
function estimateLabelWidthPx(label: string): number {
  return label.length * 6 + 12;
}

function DurationLabel({
  label,
  className,
}: {
  label: string;
  className?: string;
}): ReactNode {
  return (
    <span
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-start overflow-hidden px-1 text-[10px] font-mono font-medium leading-none whitespace-nowrap text-left text-gray-1000 tabular-nums opacity-0 group-hover/timeline-row:opacity-100',
        className
      )}
    >
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

function LeadInConnector({
  leftPct,
  widthPct,
  label,
}: {
  leftPct: number;
  widthPct: number;
  label: string | null;
}): ReactNode {
  return (
    <div
      className="absolute top-1/2 h-6 -translate-y-1/2"
      style={{
        left: `calc(${leftPct}% + 0.5px)`,
        width: `calc(${widthPct}% - 1px)`,
      }}
    >
      <div className="absolute left-0 top-1/2 h-4 w-px -translate-y-1/2 bg-gray-500" />
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gray-500" />
      {label ? <DurationLabel label={label} /> : null}
    </div>
  );
}

function SegmentBar({
  segments,
  showLabels = true,
}: {
  segments: VisibleSegment[];
  /**
   * When false, segment duration labels are suppressed. Used when a separate
   * top layer (e.g. the resumption-marker duration overlay) renders the label
   * above the markers instead, so we don't draw it twice.
   */
  showLabels?: boolean;
}): ReactNode {
  return (
    <div className="relative h-6 w-full">
      {segments.map((seg, i) => {
        if (seg.status === 'queued') {
          const leadInLabel = formatDurationPrecise(seg.fullDurationMs);
          const showLeadInLabel =
            showLabels &&
            seg.pixelWidth >= Math.max(40, estimateLabelWidthPx(leadInLabel));
          const isFullWidthQueued = segments.length === 1;
          return (
            <Fragment key={i}>
              <LeadInConnector
                leftPct={seg.leftPct}
                widthPct={seg.widthPct}
                label={showLeadInLabel ? leadInLabel : null}
              />
              {isFullWidthQueued ? (
                <div
                  className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-gray-500"
                  style={{
                    left: `calc(${seg.leftPct + seg.widthPct}% - 1.5px)`,
                  }}
                />
              ) : null}
            </Fragment>
          );
        }

        const label = formatDurationPrecise(seg.fullDurationMs);
        // Only render the label when there's enough room for it without clipping.
        const showLabel =
          showLabels &&
          seg.pixelWidth >= Math.max(40, estimateLabelWidthPx(label));

        return (
          <div
            key={i}
            className={cn(
              'absolute h-full overflow-hidden rounded-[0.25rem]',
              SEGMENT_CLASSES[seg.status]
            )}
            style={{
              // 1px gap between adjacent segments, distributed equally.
              left: `calc(${seg.leftPct}% + 0.5px)`,
              width: `calc(${seg.widthPct}% - 1px)`,
              minWidth: 1,
            }}
          >
            {STRIPED_SEGMENT_STATUSES.has(seg.status) ? (
              <AnimatedStripes status={seg.status} />
            ) : null}
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
  isDimmed,
  onSelect,
  onRevealTime,
}: {
  span: Span;
  viewStart: number;
  viewDuration: number;
  containerWidth: number;
  isSelected: boolean;
  isDimmed?: boolean;
  onSelect: (spanId: string) => void;
  onRevealTime?: (timeMs: number) => void;
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

  const baseMarkers = useMemo(() => computeSpanMarkers(span), [span]);
  const markers = useMemo(
    () =>
      geometry.mode.kind === 'full'
        ? cullCollidingMarkers(
            projectMarkers(
              baseMarkers,
              geometry.visibleStartMs,
              geometry.visibleEndMs
            ),
            geometry.visiblePixelWidth
          )
        : [],
    [geometry, baseMarkers]
  );

  // Markers that fall outside the visible window (scrolled off while zoomed in)
  // — surfaced as edge indicators so they aren't silently lost.
  const offscreen = useMemo<OffscreenMarkers>(
    () =>
      geometry.mode.kind === 'full'
        ? computeOffscreenMarkers(
            baseMarkers,
            geometry.visibleStartMs,
            geometry.visibleEndMs
          )
        : { left: null, right: null },
    [geometry, baseMarkers]
  );

  // Markers (visible or off-screen) move the duration label into the overlay,
  // so the in-bar segment label is suppressed.
  const hasMarkers =
    markers.length > 0 || offscreen.left !== null || offscreen.right !== null;

  const isErrored = isSpanErrored(span);
  const colors = getResourceColor(span.resource);
  const fallbackBg = isErrored
    ? (colors.errorBg ?? 'var(--ds-red-200)')
    : colors.bg;
  const fallbackBorder = isErrored
    ? (colors.errorBorder ?? 'var(--ds-red-500)')
    : colors.border;

  const totalLabel = formatDurationPrecise(totalDurationMs);
  const showTotalLabel =
    geometry.visiblePixelWidth >=
    Math.max(40, estimateLabelWidthPx(totalLabel));

  const handleClick = useCallback(() => {
    onSelect(span.spanId);
  }, [onSelect, span.spanId]);

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isSelected}
      aria-level={1}
      className={cn(
        'group/timeline-row h-10 relative flex items-center hover:bg-gray-100 aria-selected:bg-gray-100 aria-selected:hover:bg-gray-200 transition-opacity',
        isDimmed && 'opacity-35'
      )}
      onClick={handleClick}
    >
      <div className="absolute inset-y-0" style={TIMELINE_INSET_STYLE}>
        <div
          className="absolute top-1/2 h-6 -translate-y-1/2 overflow-hidden rounded-[0.25rem]"
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
            <SegmentBar segments={segments} showLabels={!hasMarkers} />
          ) : (
            <PlainBar
              bg={fallbackBg}
              border={fallbackBorder}
              label={showTotalLabel ? totalLabel : null}
            />
          )}
        </div>
        {/* Overlay (not clipped): ticks, off-screen indicators, then the duration label on top. */}
        {hasMarkers ? (
          <div
            className="pointer-events-none absolute top-1/2 h-6 -translate-y-1/2"
            style={getBarPositionStyle(geometry)}
          >
            {markers.length > 0 ? <MarkerLayer markers={markers} /> : null}
            {offscreen.left ? (
              <OffscreenMarkerIndicator
                direction="left"
                count={offscreen.left.count}
                targetMs={offscreen.left.nearestMs}
                onReveal={onRevealTime}
              />
            ) : null}
            {offscreen.right ? (
              <OffscreenMarkerIndicator
                direction="right"
                count={offscreen.right.count}
                targetMs={offscreen.right.nearestMs}
                onReveal={onRevealTime}
              />
            ) : null}
            {showTotalLabel ? (
              <DurationLabel
                label={totalLabel}
                // Shift clear of the left edge indicator so it isn't covered.
                className={offscreen.left ? 'pl-10' : undefined}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export { TimelineBar };

// ---------------------------------------------------------------------------
// DeltaMeasureLine (Alt-key measurement overlays: the selected ↔ hovered
// measurement, and the ambient consecutive-gap indicators shown without a
// selection)
// ---------------------------------------------------------------------------

// Horizontal distance between the anchor bar's measured edge and the vertical
// guide — also the width of the connector stub bridging the two.
const MEASURE_GUIDE_OUTSET_PX = 4;

const DeltaMeasureLine = memo(function DeltaMeasureLine({
  delta,
  anchorRowIndex,
  hoveredRowIndex,
  timelineWidth,
}: {
  delta: SpanDelta;
  anchorRowIndex: number;
  hoveredRowIndex: number;
  timelineWidth: number;
}) {
  // Both ends of the measurement align with the vertical middle of the bars
  // (bars are centered in their rows, so bar center == row center).
  const anchorCenterY = anchorRowIndex * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
  const lineY = hoveredRowIndex * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;

  // Guide connecting the middle of the anchor bar down/up to the line, so
  // the measurement's origin stays legible when the rows are far apart.
  // It sits just outside the anchor bar's measured edge (so it doesn't blend
  // into the bar's border), joined to the bar by a short horizontal stub. The
  // line runs from the elbow corner (the guide's x) to the hovered span's
  // measured edge — pulled short of the edge arrow when the hovered span is
  // fully off-screen.
  const guideTop = Math.min(anchorCenterY, lineY);
  const guideBottom = Math.max(anchorCenterY, lineY);
  const anchorX = delta.anchorFrac * timelineWidth;
  const guideX =
    anchorX +
    (delta.anchorEdge === 'end'
      ? MEASURE_GUIDE_OUTSET_PX
      : -MEASURE_GUIDE_OUTSET_PX);
  const arrowClearance =
    delta.hoveredOffscreen === 'right'
      ? -(TINY_BAR_BOX_SIZE_PX + 4)
      : delta.hoveredOffscreen === 'left'
        ? TINY_BAR_BOX_SIZE_PX + 4
        : 0;
  const hoveredX = delta.hoveredFrac * timelineWidth + arrowClearance;
  const startX = Math.min(guideX, hoveredX);
  const endX = Math.max(guideX, hoveredX);

  const label = formatDurationPrecise(delta.deltaMs);
  const labelWidthPx = estimateLabelWidthPx(label);
  // Center the label on the line; when the line is too short, place it beside
  // the right endpoint, flipping left near the viewport's right edge.
  const labelPlacement =
    endX - startX >= labelWidthPx
      ? { left: (startX + endX) / 2, translate: '-translate-x-1/2' }
      : endX + 4 + labelWidthPx <= timelineWidth
        ? { left: endX + 4, translate: '' }
        : { left: startX - 4, translate: '-translate-x-full' };

  return (
    <>
      <div
        className="absolute h-px bg-amber-800"
        style={{
          left: Math.min(anchorX, guideX),
          width: MEASURE_GUIDE_OUTSET_PX,
          top: anchorCenterY,
        }}
      />
      <div
        className="absolute w-px bg-amber-800"
        style={{
          left: guideX,
          top: guideTop,
          height: guideBottom - guideTop,
        }}
      />
      <div
        className="absolute h-px bg-amber-800"
        style={{ left: startX, width: Math.max(endX - startX, 1), top: lineY }}
      />
      <span
        className={cn(
          'absolute -translate-y-1/2 font-mono text-[10px] font-medium leading-none tabular-nums whitespace-nowrap rounded-xs bg-background-100 px-1 py-0.5 text-amber-800',
          labelPlacement.translate
        )}
        style={{ left: labelPlacement.left, top: lineY }}
      >
        {label}
      </span>
    </>
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
            key={String(m.value)}
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

export interface TimelineHover {
  /** Pointer x as a fraction of the timeline's content width, in [0, 1]. */
  fraction: number;
  /** Row index under the pointer; may be past the last row — not validated. */
  rowIndex: number;
}

export function Timeline({
  spans,
  viewStart,
  viewEnd,
  markers,
  selectedId,
  searchResult,
  onSelect,
  onRevealTime,
  hover,
  altHeld = false,
}: {
  spans: Span[];
  viewStart: number;
  viewEnd: number;
  markers: TimeMarker[];
  selectedId: string | null;
  searchResult: SpanSearchResult;
  onSelect: (spanId: string) => void;
  onRevealTime?: (timeMs: number) => void;
  hover?: TimelineHover | null;
  altHeld?: boolean;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const viewDuration = viewEnd - viewStart;
  const timelineWidth = Math.max(0, containerWidth - TIMELINE_PADDING_PX * 2);
  const { start, end } = useRowWindow(
    containerRef,
    spans.length,
    ROW_HEIGHT_PX
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Each consecutive gap renders as a measurement from the earlier span's end
  // edge to the next span's start, in the same visual language as the
  // selected ↔ hovered measurement.
  const gapMeasurements = useMemo(
    () =>
      computeSpanGaps(spans, viewStart, viewEnd).map((gap) => ({
        delta: {
          deltaMs: gap.gapMs,
          anchorFrac: gap.leftFrac,
          hoveredFrac: gap.rightFrac,
          anchorEdge: 'end',
          hoveredOffscreen: null,
        } satisfies SpanDelta,
        anchorRowIndex: gap.rowIndex,
        hoveredRowIndex: gap.rowIndex + 1,
      })),
    [spans, viewStart, viewEnd]
  );

  // With a span selected, Alt+hover measures selected ↔ hovered instead of
  // showing the all-sibling-gaps overlay.
  const anchorIndex = useMemo(
    () => (selectedId ? spans.findIndex((s) => s.spanId === selectedId) : -1),
    [spans, selectedId]
  );

  const measurement = useMemo(() => {
    if (!altHeld || hover == null || hover.rowIndex === anchorIndex) {
      return null;
    }
    const anchorSpan = spans[anchorIndex];
    const hoveredSpan = spans[hover.rowIndex];
    if (!anchorSpan || !hoveredSpan) return null;
    const delta = computeSpanDelta(anchorSpan, hoveredSpan, viewStart, viewEnd);
    return delta
      ? { delta, anchorRowIndex: anchorIndex, hoveredRowIndex: hover.rowIndex }
      : null;
  }, [altHeld, anchorIndex, hover, spans, viewStart, viewEnd]);

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-hidden"
      style={{ minHeight: spans.length * ROW_HEIGHT_PX }}
    >
      <div
        aria-hidden
        className="absolute inset-y-0 pointer-events-none"
        style={TIMELINE_INSET_STYLE}
      >
        {markers.map((marker) =>
          // Skip the "0s" origin marker since the left edge already implies it.
          Math.abs(marker.value) > 0.000001 ? (
            <div
              key={String(marker.value)}
              className="absolute top-0 bottom-0 w-px bg-gray-alpha-300"
              style={{ left: `${marker.position * 100}%` }}
            />
          ) : null
        )}
      </div>
      {hover != null && (
        <div
          className="absolute inset-y-0 pointer-events-none z-10"
          style={TIMELINE_INSET_STYLE}
        >
          <div
            className="absolute top-0 bottom-0 w-px bg-gray-alpha-500"
            style={{ left: `${hover.fraction * 100}%` }}
          />
        </div>
      )}
      <div style={{ transform: `translateY(${start * ROW_HEIGHT_PX}px)` }}>
        {spans.slice(start, end).map((span) => (
          <TimelineBar
            key={span.spanId}
            span={span}
            viewStart={viewStart}
            viewDuration={viewDuration}
            containerWidth={timelineWidth}
            isSelected={selectedId === span.spanId}
            isDimmed={isSpanDimmedBySearch(span.spanId, searchResult)}
            onSelect={onSelect}
            onRevealTime={onRevealTime}
          />
        ))}
      </div>
      {altHeld && anchorIndex < 0 && (
        <div
          aria-hidden
          className="absolute inset-y-0 pointer-events-none"
          style={TIMELINE_INSET_STYLE}
        >
          {gapMeasurements.map((gap) => (
            <DeltaMeasureLine
              key={gap.anchorRowIndex}
              {...gap}
              timelineWidth={timelineWidth}
            />
          ))}
        </div>
      )}
      {measurement && (
        <div
          aria-hidden
          className="absolute inset-y-0 pointer-events-none z-20"
          style={TIMELINE_INSET_STYLE}
        >
          <DeltaMeasureLine {...measurement} timelineWidth={timelineWidth} />
        </div>
      )}
    </div>
  );
}
