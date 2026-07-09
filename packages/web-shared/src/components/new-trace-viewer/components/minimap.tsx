'use client';

import type { ReactNode } from 'react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn';
import {
  formatDurationPrecise,
  getHighResInMs,
} from '../../trace-viewer/util/timing';
import type { Span } from '../types';
import {
  clampViewportToRoot,
  isSpanErrored,
  type RootBounds,
  type ViewportRange,
  wheelDeltaToPixels,
  wheelZoomScaleFactor,
} from '../utils';
import { TIMELINE_PADDING_PX } from './timeline';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_PAD_Y_PX = 6;
const MIN_LINE_HEIGHT_PX = 1.5;
const MAX_LINE_HEIGHT_PX = 3;
const MIN_LINE_WIDTH_PX = 2;
/** Pointer travel below this is treated as a click rather than a drag. */
const CLICK_DRAG_THRESHOLD_PX = 3;
const MIN_BRUSH_WIDTH_PX = 6;
/** Fraction of the current window that arrow keys pan by. */
const KEYBOARD_PAN_FRACTION = 0.1;

/**
 * Line colors resolved from the design-system tokens on the container, so the
 * canvas follows the active theme. Runs and steps carry the accent hues;
 * passive spans (hooks, sleeps) stay gray like their event-list icons.
 */
const RESOURCE_LINE_TOKENS: Record<string, string> = {
  run: '--ds-blue-400',
  step: '--ds-green-400',
  hook: '--ds-gray-400',
  sleep: '--ds-gray-400',
};
const DEFAULT_LINE_TOKEN = '--ds-gray-400';
const ERROR_LINE_TOKEN = '--ds-red-400';

// ---------------------------------------------------------------------------
// Density layer geometry
// ---------------------------------------------------------------------------

interface DensityLayout {
  lineHeight: number;
  /** [x, y, width] rects grouped by color token, one fill pass per color. */
  rectsByToken: Map<string, [number, number, number][]>;
}

function computeDensityLayout(
  spans: Span[],
  rootStartMs: number,
  rootDurationMs: number,
  contentWidth: number,
  contentHeight: number
): DensityLayout {
  const count = spans.length;
  const lineHeight = Math.max(
    MIN_LINE_HEIGHT_PX,
    Math.min(MAX_LINE_HEIGHT_PX, contentHeight / count)
  );
  // Distribute rows across the strip; never spread a handful of spans further
  // apart than one line + 1px gap.
  const rowStep =
    count > 1
      ? Math.min((contentHeight - lineHeight) / (count - 1), lineHeight + 1)
      : 0;

  const rectsByToken = new Map<string, [number, number, number][]>();
  spans.forEach((span, index) => {
    const token = isSpanErrored(span)
      ? ERROR_LINE_TOKEN
      : (RESOURCE_LINE_TOKENS[span.resource] ?? DEFAULT_LINE_TOKEN);
    const startMs = getHighResInMs(span.startTime);
    const endMs = getHighResInMs(span.endTime);
    const x =
      TIMELINE_PADDING_PX +
      ((startMs - rootStartMs) / rootDurationMs) * contentWidth;
    const w = Math.max(
      MIN_LINE_WIDTH_PX,
      ((endMs - startMs) / rootDurationMs) * contentWidth
    );
    const y = CANVAS_PAD_Y_PX + index * rowStep;
    const rects = rectsByToken.get(token) ?? [];
    rects.push([x, y, w]);
    rectsByToken.set(token, rects);
  });

  return { lineHeight, rectsByToken };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Track the display's device pixel ratio (changes when moving monitors). */
function useDpr(): number {
  const [dpr, setDpr] = useState(1);
  useLayoutEffect(() => {
    const onChange = (): void => setDpr(window.devicePixelRatio || 1);
    const media = matchMedia(`(resolution: ${dpr}dppx)`);
    media.addEventListener('change', onChange);
    onChange();
    return () => media.removeEventListener('change', onChange);
  }, [dpr]);
  return dpr;
}

/** Bump a counter when the theme (html class/data-theme) changes. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

type DragState =
  | { mode: 'pan'; grabOffsetMs: number }
  | { mode: 'resize-left' }
  | { mode: 'resize-right' }
  | { mode: 'select'; originX: number; originMs: number };

export const Minimap = memo(function Minimap({
  spans,
  root,
  viewport,
  minViewportMs,
  onViewportChange,
  onAnimateTo,
}: {
  spans: Span[];
  root: RootBounds;
  viewport: ViewportRange;
  minViewportMs: number;
  /** Immediate viewport update (used while dragging). */
  onViewportChange: (viewport: ViewportRange) => void;
  /** Eased viewport transition (used for click-to-jump and selections). */
  onAnimateTo: (viewport: ViewportRange) => void;
}): ReactNode {
  const {
    startTime: rootStartMs,
    endTime: rootEndMs,
    duration: rootDurationMs,
  } = root;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDpr();
  const themeVersion = useThemeVersion();

  // Latest viewport for pointer handlers, without re-binding them per frame.
  const viewportRef = useRef<ViewportRange>(viewport);
  viewportRef.current = viewport;

  const [drag, setDrag] = useState<DragState | null>(null);
  const [selection, setSelection] = useState<{ x0: number; x1: number } | null>(
    null
  );

  const xToTime = useCallback(
    (x: number, contentWidth: number): number => {
      if (contentWidth <= 0) return rootStartMs;
      const fraction = (x - TIMELINE_PADDING_PX) / contentWidth;
      return Math.min(
        Math.max(rootStartMs + fraction * rootDurationMs, rootStartMs),
        rootEndMs
      );
    },
    [rootStartMs, rootDurationMs, rootEndMs]
  );

  const clamp = useCallback(
    (next: ViewportRange): ViewportRange =>
      clampViewportToRoot(next, rootStartMs, rootEndMs, minViewportMs),
    [rootStartMs, rootEndMs, minViewportMs]
  );

  // Density canvas: one thin line per span across the full run. Sizing is
  // read live and redraws run straight from the ResizeObserver (which fires
  // before paint), so layout changes — e.g. the detail panel opening — never
  // paint a frame with a stale, stretched bitmap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeVersion is a redraw trigger — the canvas re-resolves its token colors when the theme flips
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !container || !ctx) return;

    const draw = (): void => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const contentWidth = width - TIMELINE_PADDING_PX * 2;
      if (width <= 0 || height <= 0 || contentWidth <= 0) return;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      if (spans.length === 0 || rootDurationMs <= 0) return;

      const { lineHeight, rectsByToken } = computeDensityLayout(
        spans,
        rootStartMs,
        rootDurationMs,
        contentWidth,
        height - CANVAS_PAD_Y_PX * 2
      );

      const style = getComputedStyle(container);
      const drawToken = (token: string): void => {
        const rects = rectsByToken.get(token);
        if (!rects) return;
        ctx.fillStyle =
          style.getPropertyValue(token).trim() || 'rgb(160,160,160)';
        ctx.beginPath();
        for (const [x, y, w] of rects) {
          ctx.roundRect(x, y, w, lineHeight, lineHeight / 2);
        }
        ctx.fill();
      };
      // Errored spans are drawn last so red never disappears under neighbors.
      for (const token of rectsByToken.keys()) {
        if (token !== ERROR_LINE_TOKEN) drawToken(token);
      }
      drawToken(ERROR_LINE_TOKEN);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [spans, rootStartMs, rootDurationMs, dpr, themeVersion]);

  // Content width is read from the live rect at event time, so pointer math
  // stays exact while the strip is being resized mid-gesture.
  const pointerFrame = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): { x: number; cw: number } => {
      const rect = e.currentTarget.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        cw: rect.width - TIMELINE_PADDING_PX * 2,
      };
    },
    []
  );

  const resolveDragState = useCallback(
    (target: HTMLElement, x: number, cw: number): DragState => {
      if (target.closest('[data-minimap-handle="left"]')) {
        return { mode: 'resize-left' };
      }
      if (target.closest('[data-minimap-handle="right"]')) {
        return { mode: 'resize-right' };
      }
      // Panning a full-extent window is a no-op, so let a drag on the brush
      // start a selection instead — the natural first gesture on the map.
      const { start, end } = viewportRef.current;
      const isFullExtent =
        start - rootStartMs < rootDurationMs * 0.001 &&
        rootEndMs - end < rootDurationMs * 0.001;
      if (target.closest('[data-minimap-brush]') && !isFullExtent) {
        return { mode: 'pan', grabOffsetMs: xToTime(x, cw) - start };
      }
      return { mode: 'select', originX: x, originMs: xToTime(x, cw) };
    },
    [xToTime, rootStartMs, rootDurationMs, rootEndMs]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const { x, cw } = pointerFrame(e);
      if (cw <= 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag(resolveDragState(e.target as HTMLElement, x, cw));
    },
    [pointerFrame, resolveDragState]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const { x, cw } = pointerFrame(e);
      const t = xToTime(x, cw);
      const { start, end } = viewportRef.current;

      if (drag.mode === 'pan') {
        const duration = end - start;
        onViewportChange(
          clamp({
            start: t - drag.grabOffsetMs,
            end: t - drag.grabOffsetMs + duration,
          })
        );
      } else if (drag.mode === 'resize-left') {
        onViewportChange({ start: Math.min(t, end - minViewportMs), end });
      } else if (drag.mode === 'resize-right') {
        onViewportChange({ start, end: Math.max(t, start + minViewportMs) });
      } else if (
        selection ||
        Math.abs(x - drag.originX) > CLICK_DRAG_THRESHOLD_PX
      ) {
        setSelection({
          x0: Math.min(drag.originX, x),
          x1: Math.max(drag.originX, x),
        });
      }
    },
    [
      drag,
      selection,
      pointerFrame,
      xToTime,
      onViewportChange,
      clamp,
      minViewportMs,
    ]
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      if (drag.mode === 'select') {
        const { x, cw } = pointerFrame(e);
        const t = xToTime(x, cw);
        if (selection) {
          onAnimateTo(
            clamp({
              start: Math.min(drag.originMs, t),
              end: Math.max(drag.originMs, t),
            })
          );
        } else {
          // Plain click: keep the current zoom, center the window there.
          const { start, end } = viewportRef.current;
          const duration = end - start;
          onAnimateTo(
            clamp({ start: t - duration / 2, end: t + duration / 2 })
          );
        }
      }
      setSelection(null);
      setDrag(null);
    },
    [drag, selection, pointerFrame, xToTime, onAnimateTo, clamp]
  );

  const handleLostPointerCapture = useCallback(() => {
    setSelection(null);
    setDrag(null);
  }, []);

  const handleDoubleClick = useCallback(() => {
    onAnimateTo({ start: rootStartMs, end: rootEndMs });
  }, [onAnimateTo, rootStartMs, rootEndMs]);

  // Wheel: same gestures as the timeline, mapped through the full extent.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || rootDurationMs <= 0) return;

    // The minimap's x axis is the full run, so zoom around the absolute time
    // under the cursor rather than a viewport fraction.
    const zoomAtCursor = (e: WheelEvent, cw: number, left: number): void => {
      const scaleFactor = wheelZoomScaleFactor(e);
      const { start, end } = viewportRef.current;
      const duration = end - start;
      const cursorFraction = Math.min(
        Math.max((e.clientX - left - TIMELINE_PADDING_PX) / cw, 0),
        1
      );
      const cursorMs = rootStartMs + cursorFraction * rootDurationMs;
      const anchor = Math.min(
        Math.max(duration > 0 ? (cursorMs - start) / duration : 0.5, 0),
        1
      );
      const newDuration = duration * scaleFactor;
      onViewportChange(
        clamp({
          start: cursorMs - anchor * newDuration,
          end: cursorMs + (1 - anchor) * newDuration,
        })
      );
    };

    // Pan in map coordinates: one map pixel is one full-extent fraction.
    const panByMapPixels = (e: WheelEvent, cw: number): void => {
      const dx = wheelDeltaToPixels(e.deltaX, e.deltaMode);
      const panMs = (dx / cw) * rootDurationMs;
      const { start, end } = viewportRef.current;
      onViewportChange(clamp({ start: start + panMs, end: end + panMs }));
    };

    const onWheel = (e: WheelEvent): void => {
      const isZoomGesture = e.ctrlKey || e.metaKey;
      const hasDeltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!isZoomGesture && !hasDeltaX) return;
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const cw = rect.width - TIMELINE_PADDING_PX * 2;
      if (cw <= 0) return;
      if (isZoomGesture) zoomAtCursor(e, cw, rect.left);
      else panByMapPixels(e, cw);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [rootStartMs, rootDurationMs, onViewportChange, clamp]);

  // Arrow keys pan the focused brush; Home/End jump to the ends.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const { start, end } = viewportRef.current;
      const duration = end - start;
      const pan = duration * KEYBOARD_PAN_FRACTION;
      if (e.key === 'ArrowLeft') {
        onViewportChange(clamp({ start: start - pan, end: end - pan }));
      } else if (e.key === 'ArrowRight') {
        onViewportChange(clamp({ start: start + pan, end: end + pan }));
      } else if (e.key === 'Home') {
        onViewportChange(
          clamp({ start: rootStartMs, end: rootStartMs + duration })
        );
      } else if (e.key === 'End') {
        onViewportChange(
          clamp({ start: rootEndMs - duration, end: rootEndMs })
        );
      } else {
        return;
      }
      e.preventDefault();
    },
    [onViewportChange, clamp, rootStartMs, rootEndMs]
  );

  // Brush geometry in CSS calc() from time fractions, so the thumb reflows in
  // the same frame as any container resize instead of lagging a state update.
  const startFraction = (viewport.start - rootStartMs) / rootDurationMs;
  const endFraction = (viewport.end - rootStartMs) / rootDurationMs;
  const trackWidth = `(100% - ${TIMELINE_PADDING_PX * 2}px)`;
  const brushStyle = {
    left: `calc(${TIMELINE_PADDING_PX}px + ${startFraction} * ${trackWidth})`,
    width: `max(${MIN_BRUSH_WIDTH_PX}px, calc(${
      endFraction - startFraction
    } * ${trackWidth}))`,
  };

  const viewDuration = viewport.end - viewport.start;
  const scrollableMs = Math.max(rootDurationMs - viewDuration, 0);
  const scrollPercent =
    scrollableMs > 0
      ? Math.round(((viewport.start - rootStartMs) / scrollableMs) * 100)
      : 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer gestures are a mouse-only enhancement; the brush inside is keyboard-operable
    <div
      ref={containerRef}
      className={cn(
        'relative h-10 min-h-10 w-full border-b border-gray-alpha-400 bg-background-100 select-none overflow-hidden touch-none',
        drag?.mode === 'select' && 'cursor-crosshair'
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={handleLostPointerCapture}
      onDoubleClick={handleDoubleClick}
    >
      {/* Multiply on light themes / screen on dark, so overlapping span lines
          deepen instead of occluding and the glass thumb reads through them. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full mix-blend-multiply [.dark-theme_&]:mix-blend-screen [.dark_&]:mix-blend-screen [[data-theme=dark]_&]:mix-blend-screen"
      />
      {selection ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 border border-blue-500 bg-blue-300 opacity-40"
          style={{ left: selection.x0, width: selection.x1 - selection.x0 }}
        />
      ) : null}
      <div
        data-minimap-brush
        role="scrollbar"
        aria-controls="trace-timeline"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={scrollPercent}
        aria-valuetext={`Viewing ${formatDurationPrecise(
          viewport.start - rootStartMs
        )} to ${formatDurationPrecise(
          viewport.end - rootStartMs
        )} of ${formatDurationPrecise(rootDurationMs)}`}
        aria-label="Timeline overview"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn(
          // Glass thumb, matching the legacy trace viewer's map window.
          'group/minimap-brush absolute top-0.5 bottom-0.5 rounded-[3px] border border-gray-alpha-400 bg-gray-alpha-200 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ds-focus-color)]',
          drag?.mode === 'pan' ? 'cursor-grabbing' : 'cursor-grab'
        )}
        style={brushStyle}
      >
        <div
          data-minimap-handle="left"
          className="absolute inset-y-0 -left-1 flex w-2.5 cursor-ew-resize items-center justify-center"
        >
          <span
            className={cn(
              'h-3.5 w-[3px] rounded-full bg-gray-600 opacity-0 transition-opacity group-hover/minimap-brush:opacity-100 group-focus-visible/minimap-brush:opacity-100',
              drag && 'opacity-100'
            )}
          />
        </div>
        <div
          data-minimap-handle="right"
          className="absolute inset-y-0 -right-1 flex w-2.5 cursor-ew-resize items-center justify-center"
        >
          <span
            className={cn(
              'h-3.5 w-[3px] rounded-full bg-gray-600 opacity-0 transition-opacity group-hover/minimap-brush:opacity-100 group-focus-visible/minimap-brush:opacity-100',
              drag && 'opacity-100'
            )}
          />
        </div>
      </div>
    </div>
  );
});
