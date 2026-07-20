import {
  formatDuration,
  formatDurationPrecise,
  getHighResInMs,
} from '../trace-viewer/util/timing';
import type { Span, SpanEvent } from './types';

// ---------------------------------------------------------------------------
// Root bounds
// ---------------------------------------------------------------------------

export interface RootBounds {
  startTime: number;
  endTime: number;
  duration: number;
}

export function computeRootBounds(spans: Span[]): RootBounds {
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;

  for (const span of spans) {
    const s = getHighResInMs(span.startTime);
    const e = getHighResInMs(span.endTime);
    if (s < minStart) minStart = s;
    if (e > maxEnd) maxEnd = e;
  }

  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
    return { startTime: 0, endTime: 1, duration: 1 };
  }

  const duration = Math.max(maxEnd - minStart, 1);
  return { startTime: minStart, endTime: maxEnd, duration };
}

export function getSpanDurationMs(span: Span): number {
  return Math.max(
    0,
    getHighResInMs(span.endTime) - getHighResInMs(span.startTime)
  );
}

export function isSpanErrored(span: Span): boolean {
  const workflowStatus = (span.attributes.data as Record<string, unknown>)
    ?.status as string | undefined;
  return span.status.code === 2 || workflowStatus === 'failed';
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export interface ViewportRange {
  start: number;
  end: number;
}

/**
 * Clamp a candidate viewport to the root extent. The requested duration is
 * preserved where possible (clamped to [minDurationMs, root duration]), then
 * the window is shifted back inside the root bounds.
 */
export function clampViewportToRoot(
  next: ViewportRange,
  rootStart: number,
  rootEnd: number,
  minDurationMs: number
): ViewportRange {
  const rootDuration = Math.max(rootEnd - rootStart, minDurationMs);
  const duration = Math.min(
    rootDuration,
    Math.max(minDurationMs, next.end - next.start)
  );
  const maxStart = rootEnd - duration;
  const start = Math.min(Math.max(next.start, rootStart), maxStart);
  return { start, end: start + duration };
}

// ---------------------------------------------------------------------------
// Wheel gestures — shared between the timeline and the minimap
// ---------------------------------------------------------------------------

/** Convert a wheel delta to pixel units (line-mode deltas arrive in lines). */
export function wheelDeltaToPixels(delta: number, deltaMode: number): number {
  return deltaMode === 1 ? delta * 16 : delta;
}

/**
 * Exponential zoom factor for a wheel gesture. Coarse mouse-wheel steps are
 * damped harder than trackpad pinches so both feel similar.
 */
export function wheelZoomScaleFactor(event: {
  deltaY: number;
  deltaMode: number;
}): number {
  const dy = wheelDeltaToPixels(event.deltaY, event.deltaMode);
  const isMouseWheel = event.deltaMode === 1 || Math.abs(event.deltaY) >= 50;
  return 2 ** (dy / (isMouseWheel ? 200 : 60));
}

// ---------------------------------------------------------------------------
// Time markers
// ---------------------------------------------------------------------------

export interface TimeMarker {
  position: number;
  label: string;
  value: number;
}

const NICE_INTERVALS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000,
  50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000,
  10_000_000, 20_000_000, 50_000_000, 100_000_000, 200_000_000, 500_000_000,
  1_000_000_000, 2_000_000_000, 5_000_000_000,
];

const MAX_MARKERS = 8;

const MS_IN_SECOND = 1000;

function pickInterval(viewDuration: number, maxTicks: number): number {
  for (const interval of NICE_INTERVALS) {
    if (viewDuration / interval <= maxTicks) return interval;
  }
  return NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

export function computeTimeMarkers(
  viewDuration: number,
  offset: number
): TimeMarker[] {
  if (viewDuration <= 0) return [];

  const maxTicks = 6;
  const interval = pickInterval(viewDuration, maxTicks);

  // Sub-second steps need fractional labels, or ticks past 1s collide as
  // duplicate whole seconds ("…1s, 2s, 2s, 3s"). Scale decimals to the step.
  const fractionDigits =
    interval >= MS_IN_SECOND
      ? 0
      : Math.ceil(-Math.log10(interval / MS_IN_SECOND));

  const firstTick = Math.ceil(offset / interval) * interval;
  const markers: TimeMarker[] = [];

  for (let t = firstTick; t <= offset + viewDuration; t += interval) {
    const position = (t - offset) / viewDuration;
    if (position < -0.01 || position > 1.01) continue;
    markers.push({
      position: Math.min(Math.max(position, 0), 1),
      label:
        fractionDigits === 0
          ? formatDuration(Math.abs(t), true)
          : formatDurationPrecise(Math.abs(t), fractionDigits),
      value: t,
    });
    if (markers.length >= MAX_MARKERS) break;
  }

  return markers;
}

// ---------------------------------------------------------------------------
// Span gaps — time deltas between consecutive spans (Alt-key overlay)
// ---------------------------------------------------------------------------

export interface SpanGap {
  gapMs: number;
  leftFrac: number;
  rightFrac: number;
  rowIndex: number;
}

/** Project an absolute time onto the viewport as a clamped [0, 1] fraction. */
function toViewportFrac(ms: number, viewStart: number, range: number): number {
  return Math.min(Math.max((ms - viewStart) / range, 0), 1);
}

export function computeSpanGaps(
  spans: Span[],
  viewStart: number,
  viewEnd: number
): SpanGap[] {
  const range = viewEnd - viewStart;
  if (range <= 0) return [];

  const gaps: SpanGap[] = [];
  for (let i = 0; i < spans.length - 1; i++) {
    const endTime = getHighResInMs(spans[i].endTime);
    const startTime = getHighResInMs(spans[i + 1].startTime);
    const gapMs = startTime - endTime;
    if (gapMs <= 0) continue;

    const leftFrac = toViewportFrac(endTime, viewStart, range);
    const rightFrac = toViewportFrac(startTime, viewStart, range);
    if (rightFrac - leftFrac < 0.001) continue;

    gaps.push({ gapMs, leftFrac, rightFrac, rowIndex: i });
  }
  return gaps;
}

export interface SpanDelta {
  /** True measured time between the two spans, unaffected by clamping. */
  deltaMs: number;
  /** Viewport-clamped fraction of the anchor span's measured edge. */
  anchorFrac: number;
  /** Viewport-clamped fraction of the hovered span's measured edge. */
  hoveredFrac: number;
  /**
   * Which edge of the anchor span the measurement runs from: its end when the
   * spans are disjoint and the anchor comes first, otherwise its start.
   */
  anchorEdge: 'start' | 'end';
  /**
   * Set when the hovered span lies entirely outside the viewport on one side,
   * i.e. its row renders an off-screen arrow the line should stop short of.
   */
  hoveredOffscreen: 'left' | 'right' | null;
}

/**
 * Measure the temporal delta between an anchor (selected) span and a hovered
 * span for the Alt+hover measurement overlay. Ordering the two spans by start
 * time (E = earlier-starting, L = later-starting), the measurement runs to
 * L's start from E's end when the spans are disjoint ("how long after E ended
 * did L start"), or from E's start when they overlap ("how long after E
 * started did L start"). Fractions are clamped to the viewport like
 * `computeSpanGaps`; `deltaMs` is always the true duration. Returns null when
 * the measurement lies entirely outside the viewport.
 */
export function computeSpanDelta(
  anchor: Span,
  hovered: Span,
  viewStart: number,
  viewEnd: number
): SpanDelta | null {
  const range = viewEnd - viewStart;
  if (range <= 0) return null;

  const anchorStart = getHighResInMs(anchor.startTime);
  const hoveredStart = getHighResInMs(hovered.startTime);
  const anchorIsEarlier = anchorStart <= hoveredStart;
  const earlierStart = anchorIsEarlier ? anchorStart : hoveredStart;
  const earlierEnd = getHighResInMs(
    anchorIsEarlier ? anchor.endTime : hovered.endTime
  );
  const laterStart = anchorIsEarlier ? hoveredStart : anchorStart;

  const originMs = earlierEnd <= laterStart ? earlierEnd : earlierStart;
  const deltaMs = laterStart - originMs;

  // Entirely outside the viewport. Compared in time-space (not clamped
  // fractions) so a zero-delta point sitting exactly on a viewport edge —
  // e.g. the root span selected at default zoom — still renders.
  if (laterStart < viewStart || originMs > viewEnd) {
    return null;
  }

  const originFrac = toViewportFrac(originMs, viewStart, range);
  const laterFrac = toViewportFrac(laterStart, viewStart, range);

  const hoveredEnd = getHighResInMs(hovered.endTime);

  return {
    deltaMs,
    anchorFrac: anchorIsEarlier ? originFrac : laterFrac,
    hoveredFrac: anchorIsEarlier ? laterFrac : originFrac,
    anchorEdge: anchorIsEarlier && earlierEnd <= laterStart ? 'end' : 'start',
    hoveredOffscreen:
      hoveredStart > viewEnd ? 'right' : hoveredEnd < viewStart ? 'left' : null,
  };
}

// ---------------------------------------------------------------------------
// Resource colors
// ---------------------------------------------------------------------------

export const RESOURCE_COLORS: Record<
  string,
  {
    bg: string;
    border: string;
    errorBg?: string;
    errorBorder?: string;
  }
> = {
  run: {
    bg: 'var(--ds-blue-200)',
    border: 'var(--ds-blue-500)',
    errorBg: 'var(--ds-red-200)',
    errorBorder: 'var(--ds-red-500)',
  },
  step: {
    bg: 'var(--ds-green-200)',
    border: 'var(--ds-green-500)',
    errorBg: 'var(--ds-red-200)',
    errorBorder: 'var(--ds-red-500)',
  },
  // Passive spans (hooks) stay gray — matches event-list icons and the minimap.
  hook: {
    bg: 'var(--ds-gray-200)',
    border: 'var(--ds-gray-500)',
    errorBg: 'var(--ds-red-200)',
    errorBorder: 'var(--ds-red-500)',
  },
  sleep: {
    bg: 'var(--ds-purple-200)',
    border: 'var(--ds-purple-500)',
    errorBg: 'var(--ds-red-200)',
    errorBorder: 'var(--ds-red-500)',
  },
  default: {
    bg: 'var(--ds-gray-200)',
    border: 'var(--ds-gray-500)',
    errorBg: 'var(--ds-red-200)',
    errorBorder: 'var(--ds-red-500)',
  },
};

export function getResourceColor(resource: string): {
  bg: string;
  border: string;
  errorBg?: string;
  errorBorder?: string;
} {
  return RESOURCE_COLORS[resource] ?? RESOURCE_COLORS.default;
}

// ---------------------------------------------------------------------------
// Span segments — split a timeline bar into colored sections by event state
// ---------------------------------------------------------------------------

export type SegmentStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'succeeded'
  | 'waiting'
  | 'sleeping'
  | 'received';

export interface Segment {
  startFraction: number;
  endFraction: number;
  status: SegmentStatus;
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function timeToFraction(
  time: number,
  spanStart: number,
  spanDuration: number
): number {
  if (spanDuration <= 0) return 0;
  return clampFraction((time - spanStart) / spanDuration);
}

interface EventMark {
  time: number;
  type: string;
}

function sortedEventMarks(
  events: SpanEvent[],
  relevantNames: string[]
): EventMark[] {
  return events
    .filter((e) => relevantNames.includes(e.name))
    .map((e) => ({ time: getHighResInMs(e.timestamp), type: e.name }))
    .sort((a, b) => a.time - b.time);
}

function computeStepSegmentsFromSpan(
  startMs: number,
  duration: number,
  events: SpanEvent[]
): Segment[] {
  const segments: Segment[] = [];
  if (duration <= 0) return segments;

  const marks = sortedEventMarks(events, [
    'step_started',
    'step_retrying',
    'step_failed',
    'step_completed',
  ]);

  if (marks.length === 0) {
    segments.push({ startFraction: 0, endFraction: 1, status: 'queued' });
    return segments;
  }

  const firstFraction = timeToFraction(marks[0].time, startMs, duration);
  if (firstFraction > 0.001) {
    segments.push({
      startFraction: 0,
      endFraction: firstFraction,
      status: 'queued',
    });
  }

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const markFrac = timeToFraction(mark.time, startMs, duration);
    const nextMark = marks[i + 1];
    const nextFrac = nextMark
      ? timeToFraction(nextMark.time, startMs, duration)
      : 1;

    if (mark.type === 'step_started') {
      if (i === marks.length - 1) {
        segments.push({
          startFraction: markFrac,
          endFraction: 1,
          status: 'succeeded',
        });
      } else {
        const nextType = nextMark.type;
        const attemptStatus: SegmentStatus =
          nextType === 'step_retrying' || nextType === 'step_failed'
            ? 'failed'
            : nextType === 'step_completed'
              ? 'succeeded'
              : 'retrying';
        segments.push({
          startFraction: markFrac,
          endFraction: nextFrac,
          status: attemptStatus,
        });
      }
    } else if (mark.type === 'step_retrying') {
      segments.push({
        startFraction: markFrac,
        endFraction: nextFrac,
        status: 'retrying',
      });
    } else if (mark.type === 'step_failed') {
      if (markFrac < 0.999) {
        segments.push({
          startFraction: markFrac,
          endFraction: 1,
          status: 'failed',
        });
      }
    }
  }

  return segments;
}

function computeHookSegmentsFromSpan(
  startMs: number,
  duration: number,
  events: SpanEvent[]
): Segment[] {
  const segments: Segment[] = [];
  if (duration <= 0) return segments;

  const disposed = sortedEventMarks(events, ['hook_disposed'])[0];
  const disposedFrac = disposed
    ? timeToFraction(disposed.time, startMs, duration)
    : null;

  const waitingEnd = disposedFrac ?? 1;
  if (waitingEnd > 0.001) {
    segments.push({
      startFraction: 0,
      endFraction: waitingEnd,
      status: 'waiting',
    });
  }

  if (disposedFrac !== null && disposedFrac < 0.999) {
    segments.push({
      startFraction: disposedFrac,
      endFraction: 1,
      status: 'succeeded',
    });
  }

  return segments;
}

function computeSleepSegmentsFromSpan(
  _startMs: number,
  duration: number,
  _events: SpanEvent[]
): Segment[] {
  if (duration <= 0) return [];
  return [{ startFraction: 0, endFraction: 1, status: 'sleeping' }];
}

function runSegmentStatus(runStatus: string | undefined): SegmentStatus {
  if (runStatus === 'failed') return 'failed';
  if (runStatus === 'pending') return 'pending';
  if (runStatus === 'running') return 'running';
  return 'completed';
}

function computeRunSegmentsFromSpan(
  startMs: number,
  duration: number,
  activeStartMs: number | undefined,
  events: SpanEvent[],
  attributes: Record<string, unknown>
): Segment[] {
  const segments: Segment[] = [];
  if (duration <= 0) return segments;

  const sorted = [...events]
    .map((e) => ({ name: e.name, time: getHighResInMs(e.timestamp) }))
    .sort((a, b) => a.time - b.time);

  const runData = attributes?.data as Record<string, unknown> | undefined;
  const runStatus = runData?.status as string | undefined;

  const hasRunCreated = sorted.some((e) => e.name === 'run_created');

  if (!hasRunCreated) {
    return computeV1RunSegments(startMs, duration, activeStartMs, runStatus);
  }

  const failedEvent = sorted.find((e) => e.name === 'run_failed');

  let cursor = 0;
  if (activeStartMs !== undefined && activeStartMs > startMs) {
    const queuedFrac = timeToFraction(activeStartMs, startMs, duration);
    if (queuedFrac > 0.001) {
      segments.push({
        startFraction: 0,
        endFraction: queuedFrac,
        status: 'queued',
      });
      cursor = queuedFrac;
    }
  }

  segments.push({
    startFraction: cursor,
    endFraction: 1,
    status: failedEvent ? 'failed' : runSegmentStatus(runStatus),
  });

  return segments;
}

function computeV1RunSegments(
  startMs: number,
  duration: number,
  activeStartMs: number | undefined,
  runStatus: string | undefined
): Segment[] {
  const segments: Segment[] = [];

  let cursor = 0;
  if (activeStartMs !== undefined && activeStartMs > startMs) {
    const queuedFrac = timeToFraction(activeStartMs, startMs, duration);
    if (queuedFrac > 0.001) {
      segments.push({
        startFraction: 0,
        endFraction: queuedFrac,
        status: 'queued',
      });
      cursor = queuedFrac;
    }
  }

  segments.push({
    startFraction: cursor,
    endFraction: 1,
    status: runSegmentStatus(runStatus),
  });

  return segments;
}

/**
 * Compute event-based segments for a span. Dispatches on `span.resource`
 * to the appropriate resource-type-specific segment builder.
 * Returns an empty array for generic (non-workflow) spans.
 */
export function computeSpanSegments(span: Span): Segment[] {
  const startMs = getHighResInMs(span.startTime);
  const duration = getSpanDurationMs(span);
  const activeStartMs = span.activeStartTime
    ? getHighResInMs(span.activeStartTime)
    : undefined;

  switch (span.resource) {
    case 'step':
      return computeStepSegmentsFromSpan(startMs, duration, span.events);
    case 'hook':
      return computeHookSegmentsFromSpan(startMs, duration, span.events);
    case 'sleep':
      return computeSleepSegmentsFromSpan(startMs, duration, span.events);
    case 'run':
      return computeRunSegmentsFromSpan(
        startMs,
        duration,
        activeStartMs,
        span.events,
        span.attributes
      );
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Span markers — point-in-time events rendered as ticks on top of a bar
// ---------------------------------------------------------------------------

export interface SpanMarker {
  timeMs: number;
}

// `hook_received` = a resumption; `attr_set` = attributes written mid-span.
const MARKER_EVENT_NAMES = ['hook_received', 'attr_set'];

export function computeSpanMarkers(span: Span): SpanMarker[] {
  return sortedEventMarks(span.events, MARKER_EVENT_NAMES).map((mark) => ({
    timeMs: mark.time,
  }));
}

export interface OffscreenSide {
  count: number;
  /** Nearest off-screen marker — the one a reveal jumps to. */
  nearestMs: number;
}

export interface OffscreenMarkers {
  left: OffscreenSide | null;
  right: OffscreenSide | null;
}

/** Partition markers outside `[visibleStartMs, visibleEndMs]` by side. */
export function computeOffscreenMarkers(
  markers: SpanMarker[],
  visibleStartMs: number,
  visibleEndMs: number
): OffscreenMarkers {
  let leftCount = 0;
  let rightCount = 0;
  let nearestLeft = Number.NEGATIVE_INFINITY;
  let nearestRight = Number.POSITIVE_INFINITY;
  for (const { timeMs } of markers) {
    if (timeMs < visibleStartMs) {
      leftCount++;
      if (timeMs > nearestLeft) nearestLeft = timeMs;
    } else if (timeMs > visibleEndMs) {
      rightCount++;
      if (timeMs < nearestRight) nearestRight = timeMs;
    }
  }
  return {
    left: leftCount > 0 ? { count: leftCount, nearestMs: nearestLeft } : null,
    right:
      rightCount > 0 ? { count: rightCount, nearestMs: nearestRight } : null,
  };
}
