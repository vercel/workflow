import type { Span } from '../trace-viewer/types';
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

// ---------------------------------------------------------------------------
// Time compression
// ---------------------------------------------------------------------------

export interface TimeCompression {
  toVisual(time: number): number;
  isCompressed: boolean;
}

export function buildTimeCompression(
  _spans: Span[],
  viewStart: number,
  viewEnd: number
): TimeCompression {
  const range = viewEnd - viewStart;

  return {
    isCompressed: false,
    toVisual(time: number): number {
      if (range <= 0) return 0;
      return Math.min(Math.max((time - viewStart) / range, 0), 1);
    },
  };
}

// ---------------------------------------------------------------------------
// Time markers
// ---------------------------------------------------------------------------

export interface TimeMarker {
  position: number;
  label: string;
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
    });
    if (markers.length >= MAX_MARKERS) break;
  }

  return markers;
}

export function computeCompressedTimeMarkers(
  compression: TimeCompression,
  viewStart: number,
  viewEnd: number,
  rootStart: number
): TimeMarker[] {
  const viewDuration = viewEnd - viewStart;
  if (viewDuration <= 0) return [];

  const maxTicks = 6;
  const interval = pickInterval(viewDuration, maxTicks);
  const offset = viewStart - rootStart;

  const firstTick = Math.ceil(offset / interval) * interval;
  const markers: TimeMarker[] = [];

  for (let t = firstTick; t <= offset + viewDuration; t += interval) {
    const absTime = rootStart + t;
    const position = compression.toVisual(absTime);
    if (position < -0.01 || position > 1.01) continue;
    markers.push({
      position: Math.min(Math.max(position, 0), 1),
      label: formatDuration(Math.abs(t), true),
    });
    if (markers.length >= MAX_MARKERS) break;
  }

  return markers;
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
