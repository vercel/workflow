import type { Span, SpanEvent } from '../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../trace-viewer/util/timing';

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

  const firstTick = Math.ceil(offset / interval) * interval;
  const markers: TimeMarker[] = [];

  for (let t = firstTick; t <= offset + viewDuration; t += interval) {
    const position = (t - offset) / viewDuration;
    if (position < -0.01 || position > 1.01) continue;
    markers.push({
      position: Math.min(Math.max(position, 0), 1),
      label: formatDuration(Math.abs(t), true),
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

    const leftFrac = Math.min(Math.max((endTime - viewStart) / range, 0), 1);
    const rightFrac = Math.min(Math.max((startTime - viewStart) / range, 0), 1);
    if (rightFrac - leftFrac < 0.001) continue;

    gaps.push({ gapMs, leftFrac, rightFrac, rowIndex: i });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Resource colors
// ---------------------------------------------------------------------------

export const RESOURCE_COLORS: Record<
  string,
  { bar: string; errorBar?: string }
> = {
  run: { bar: 'var(--ds-blue-700)', errorBar: 'var(--ds-red-700)' },
  step: { bar: 'var(--ds-green-700)', errorBar: 'var(--ds-red-700)' },
  hook: { bar: 'var(--ds-amber-700)', errorBar: 'var(--ds-red-700)' },
  sleep: { bar: 'var(--ds-purple-700)', errorBar: 'var(--ds-red-700)' },
  default: { bar: 'var(--ds-gray-500)', errorBar: 'var(--ds-red-700)' },
};

export function getResourceColor(resource: string): {
  bar: string;
  errorBar?: string;
} {
  return RESOURCE_COLORS[resource] ?? RESOURCE_COLORS.default;
}

// ---------------------------------------------------------------------------
// Span segments — split a timeline bar into colored sections by event state
// ---------------------------------------------------------------------------

export type SegmentStatus =
  | 'queued'
  | 'running'
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
    segments.push({ startFraction: 0, endFraction: 1, status: 'running' });
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
              : 'running';
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

  const sorted = [...events]
    .map((e) => ({ name: e.name, time: getHighResInMs(e.timestamp) }))
    .sort((a, b) => a.time - b.time);

  const received = sorted.find((e) => e.name === 'hook_received');
  const disposed = sorted.find((e) => e.name === 'hook_disposed');

  if (!received && !disposed) {
    segments.push({ startFraction: 0, endFraction: 1, status: 'waiting' });
    return segments;
  }

  const receivedFrac = received
    ? timeToFraction(received.time, startMs, duration)
    : null;
  const disposedFrac = disposed
    ? timeToFraction(disposed.time, startMs, duration)
    : null;

  if (receivedFrac !== null && receivedFrac > 0.001) {
    segments.push({
      startFraction: 0,
      endFraction: receivedFrac,
      status: 'waiting',
    });
  } else if (receivedFrac === null && disposedFrac !== null) {
    segments.push({
      startFraction: 0,
      endFraction: disposedFrac,
      status: 'waiting',
    });
  }

  if (receivedFrac !== null) {
    segments.push({
      startFraction: receivedFrac,
      endFraction: disposedFrac ?? 1,
      status: 'received',
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

  const hasRunCreated = sorted.some((e) => e.name === 'run_created');

  if (!hasRunCreated) {
    const runData = attributes?.data as Record<string, unknown> | undefined;
    const runStatus = runData?.status as string | undefined;
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
    status: failedEvent ? 'failed' : 'running',
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
    status: runStatus === 'failed' ? 'failed' : 'running',
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
