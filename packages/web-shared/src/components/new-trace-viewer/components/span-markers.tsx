'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import { TimestampTooltip } from '../../ui/timestamp-tooltip';
import type { SpanMarker } from '../utils';

// ---------------------------------------------------------------------------
// Marker projection
// ---------------------------------------------------------------------------

export interface VisibleMarker {
  leftPct: number;
  /** Absolute (epoch) timestamp in ms — for the tooltip. */
  timeMs: number;
}

/**
 * Project point-in-time markers onto the visible window `[visibleStartMs,
 * visibleEndMs]` of a bar, as percentages of that window. Markers outside the
 * window are dropped.
 */
export function projectMarkers(
  markers: SpanMarker[],
  visibleStartMs: number,
  visibleEndMs: number
): VisibleMarker[] {
  const visibleDurationMs = visibleEndMs - visibleStartMs;
  if (visibleDurationMs <= 0) return [];

  return markers.flatMap((m) => {
    if (m.timeMs < visibleStartMs || m.timeMs > visibleEndMs) {
      return [];
    }
    return [
      {
        leftPct: ((m.timeMs - visibleStartMs) / visibleDurationMs) * 100,
        timeMs: m.timeMs,
      },
    ];
  });
}

/** Min pixel gap a tick needs from the last-kept one, else it's culled. */
const MARKER_MIN_GAP_PX = 16;

/**
 * Thin out ticks that would visually collide: walk left-to-right and keep each
 * one unless it sits within MARKER_MIN_GAP_PX of the last kept tick. Well-spaced
 * markers survive even when a tight cluster elsewhere on the bar gets thinned —
 * zoom in to resolve a cluster.
 */
export function cullCollidingMarkers(
  projected: VisibleMarker[],
  pixelWidth: number
): VisibleMarker[] {
  const kept: VisibleMarker[] = [];
  let lastKeptPct = Number.NEGATIVE_INFINITY;
  for (const m of projected) {
    const gapPx = ((m.leftPct - lastKeptPct) / 100) * pixelWidth;
    if (gapPx < MARKER_MIN_GAP_PX) continue;
    kept.push(m);
    lastKeptPct = m.leftPct;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Marker glyph: a rounded vertical tick (3px wide). */
function MarkerTick({ className }: { className?: string }): ReactNode {
  return (
    <span
      className={cn('block w-[3px] rounded-full bg-gray-1000', className)}
    />
  );
}

/**
 * Point-in-time markers overlaid on a bar — one vertical tick per event (hook
 * resumptions and attribute writes), centered on the bar. Each tick sits inside
 * a larger hit target and, on hover, shows the shared `TimestampTooltip` card
 * (the same light Geist card used for every other timestamp in the app, e.g. the
 * attribute panel and event list) so the time reads consistently with the rest
 * of the product. The position is clamped a hair inside the bar so an edge
 * marker never jams the rounded corner.
 */
export function MarkerLayer({
  markers,
}: {
  markers: VisibleMarker[];
}): ReactNode {
  return (
    <>
      {markers.map((m) => (
        <span
          key={m.timeMs}
          className="pointer-events-auto absolute top-0 bottom-0 z-10 flex w-8 -translate-x-1/2 items-center justify-center"
          style={{ left: `clamp(8px, ${m.leftPct}%, calc(100% - 8px))` }}
        >
          <TimestampTooltip date={m.timeMs}>
            <span className="flex h-6 w-8 items-center justify-center">
              <MarkerTick className="h-3" />
            </span>
          </TimestampTooltip>
        </span>
      ))}
    </>
  );
}

/**
 * Edge indicator for markers that have scrolled out of view while zoomed in.
 * Pinned flush to the corresponding edge of the visible bar, it shows the marker
 * glyph plus a chevron pointing the way to scroll. The chevron always sits on
 * the outer (off-screen) side, in a box that lines up with the bare
 * BoundaryArrow on adjacent rows.
 */
export function OffscreenMarkerIndicator({
  direction,
  count,
  targetMs,
  onReveal,
}: {
  direction: 'left' | 'right';
  count: number;
  targetMs: number;
  onReveal?: (timeMs: number) => void;
}): ReactNode {
  const Chevron = direction === 'right' ? ArrowRight : ArrowLeft;
  const label = `${count} marker${count === 1 ? '' : 's'} ${
    direction === 'right' ? 'ahead' : 'behind'
  } — click to scroll to ${count === 1 ? 'it' : 'the nearest'}`;
  const chevron = (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
      <Chevron className="size-3 text-gray-900" />
    </span>
  );
  const tick = <MarkerTick className="h-3.5 shrink-0" />;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // Don't let the row's onClick fire — revealing shouldn't also
        // change the span selection.
        e.stopPropagation();
        onReveal?.(targetMs);
      }}
      className={cn(
        'pointer-events-auto absolute top-1/2 z-20 flex h-6 -translate-y-1/2 cursor-pointer items-center rounded-[0.25rem] border border-gray-alpha-400 bg-background-100 hover:bg-gray-100',
        direction === 'right' ? 'right-0 pl-1.5' : 'left-0 pr-1.5'
      )}
    >
      {direction === 'left' ? (
        <>
          {chevron}
          {tick}
        </>
      ) : (
        <>
          {tick}
          {chevron}
        </>
      )}
    </button>
  );
}
