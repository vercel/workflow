'use client';

import { RotateCcw, Search, ZoomIn, ZoomOut } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLoadMoreOnScroll } from '../../hooks/use-load-more-on-scroll';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { formatDuration, getHighResInMs } from '../trace-viewer/util/timing';
import { IconButton } from '../ui/icon-button';
import { Kbd } from '../ui/kbd';
import { Spinner } from '../ui/spinner';
import { TooltipProvider } from '../ui/tooltip';
import { TraceDetailPanel } from './components/detail-panel';
import EventList from './components/event-list';
import { SplitPane } from './components/split-pane';
import {
  TIMELINE_PADDING_PX,
  Timeline,
  TimelineHeader,
} from './components/timeline';
import { TraceShortcutHelper } from './components/trace-shortcut-helper';
import { ROW_HEIGHT_PX, scrollRowIntoView } from './components/use-row-window';
import { ActiveSpanProvider, useActiveSpan } from './context';
import { searchSpans } from './search';
import type { TraceWithMeta } from './types';
import { computeRootBounds, computeTimeMarkers } from './utils';

interface NewTraceViewerProps {
  trace: TraceWithMeta;
  onLoadMore?: () => void | Promise<void>;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

const MIN_VIEWPORT_MS = 0.001;

const ZOOM_DEBOUNCE_MS = 150;

interface Viewport {
  start: number;
  end: number;
}

function useAnimatedViewport(initial: Viewport) {
  const [viewport, setViewportState] = useState<Viewport>(initial);
  const animRef = useRef<{
    raf: number;
    from: Viewport;
    to: Viewport;
    start: number;
  } | null>(null);
  const currentRef = useRef(initial);
  currentRef.current = viewport;
  const reducedMotion = useReducedMotion();

  const cancel = useCallback(() => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current.raf);
      animRef.current = null;
    }
  }, []);

  const animateTo = useCallback(
    (target: Viewport) => {
      cancel();

      if (reducedMotion) {
        currentRef.current = target;
        setViewportState(target);
        return;
      }

      const from = currentRef.current;
      const anim = { raf: 0, from, to: target, start: performance.now() };

      const tick = () => {
        const t = Math.min((performance.now() - anim.start) / 150, 1);
        const e = 1 - (1 - t) * (1 - t);
        setViewportState({
          start: anim.from.start + (anim.to.start - anim.from.start) * e,
          end: anim.from.end + (anim.to.end - anim.from.end) * e,
        });
        if (t < 1) anim.raf = requestAnimationFrame(tick);
        else animRef.current = null;
      };

      animRef.current = anim;
      anim.raf = requestAnimationFrame(tick);
    },
    [cancel, reducedMotion]
  );

  const setViewport = useCallback(
    (update: Viewport | ((prev: Viewport) => Viewport)) => {
      cancel();
      if (typeof update === 'function') {
        setViewportState((prev) => {
          const next = update(prev);
          currentRef.current = next;
          return next;
        });
      } else {
        currentRef.current = update;
        setViewportState(update);
      }
    },
    [cancel]
  );

  useEffect(() => cancel, [cancel]);

  return { viewport, setViewport, animateTo };
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function NewTraceViewer({
  trace,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: NewTraceViewerProps): ReactNode {
  return (
    <TooltipProvider delayDuration={300}>
      <ActiveSpanProvider spans={trace.spans}>
        <NewTraceViewerContent
          trace={trace}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
        />
      </ActiveSpanProvider>
    </TooltipProvider>
  );
}

function NewTraceViewerContent({
  trace,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: NewTraceViewerProps): ReactNode {
  const { activeSpanId, setActiveSpan, clearActiveSpan } = useActiveSpan();

  const reducedMotion = useReducedMotion();

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const paneRootRef = useRef<HTMLDivElement>(null);

  const searchResult = useMemo(
    () => searchSpans(trace.spans, deferredSearchQuery),
    [trace.spans, deferredSearchQuery]
  );

  const root = useMemo(() => computeRootBounds(trace.spans), [trace.spans]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMore = useCallback(() => {
    void onLoadMore?.();
  }, [onLoadMore]);
  const loadMoreSentinelRef = useLoadMoreOnScroll(loadMore, {
    hasMore: Boolean(onLoadMore && hasMore),
    isLoadingMore: Boolean(isLoadingMore),
    rootRef: scrollContainerRef,
  });

  const { viewport, setViewport, animateTo } = useAnimatedViewport({
    start: root.startTime,
    end: root.startTime + root.duration,
  });

  const prevRootRef = useRef<Viewport>({
    start: root.startTime,
    end: root.startTime + root.duration,
  });

  useEffect(() => {
    const prevRoot = prevRootRef.current;
    const newStart = root.startTime;
    const newEnd = root.startTime + root.duration;

    setViewport((prev) => {
      const wasAtFullExtent =
        Math.abs(prev.start - prevRoot.start) < 0.01 &&
        Math.abs(prev.end - prevRoot.end) < 0.01;

      if (wasAtFullExtent) {
        return { start: newStart, end: newEnd };
      }
      return prev;
    });

    prevRootRef.current = { start: newStart, end: newEnd };
  }, [root.startTime, root.duration, setViewport]);

  const viewDuration = viewport.end - viewport.start;

  // Keep a ref to the live viewport so the reveal callback can read the current
  // zoom without being recreated on every pan (which would bust TimelineBar's
  // memo and re-render every row each animation frame).
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const timeMarkers = useMemo(
    () => computeTimeMarkers(viewDuration, viewport.start - root.startTime),
    [viewDuration, viewport.start, root.startTime]
  );

  const resetZoom = useCallback(() => {
    animateTo({ start: root.startTime, end: root.startTime + root.duration });
  }, [animateTo, root.startTime, root.duration]);

  // Pan (keeping the current zoom) so `timeMs` is centered in view — used by the
  // off-screen marker indicators to scroll their marker into view.
  const handleRevealTime = useCallback(
    (timeMs: number) => {
      const rootS = root.startTime;
      const rootE = root.startTime + root.duration;
      const { start, end } = viewportRef.current;
      const duration = end - start;
      let newStart = timeMs - duration / 2;
      let newEnd = timeMs + duration / 2;
      if (newStart < rootS) {
        newStart = rootS;
        newEnd = rootS + duration;
      }
      if (newEnd > rootE) {
        newEnd = rootE;
        newStart = Math.max(rootS, rootE - duration);
      }
      animateTo({ start: newStart, end: newEnd });
    },
    [animateTo, root.startTime, root.duration]
  );

  const ZOOM_FACTOR = 0.5;

  const zoomBy = useCallback(
    (factor: number) => {
      const rootS = root.startTime;
      const rootE = root.startTime + root.duration;
      const rootD = root.duration;

      setViewport((prev) => {
        const prevDuration = prev.end - prev.start;
        const center = (prev.start + prev.end) / 2;
        const newDuration = Math.max(
          MIN_VIEWPORT_MS,
          Math.min(rootD, prevDuration * factor)
        );
        let newStart = center - newDuration / 2;
        let newEnd = center + newDuration / 2;

        if (newStart < rootS) {
          newStart = rootS;
          newEnd = rootS + newDuration;
        }
        if (newEnd > rootE) {
          newEnd = rootE;
          newStart = Math.max(rootS, rootE - newDuration);
        }

        return { start: newStart, end: newEnd };
      });
    },
    [setViewport, root.startTime, root.duration]
  );

  const zoomIn = useCallback(() => zoomBy(ZOOM_FACTOR), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_FACTOR), [zoomBy]);
  const isAtMinZoom = viewDuration >= root.duration;
  const isAtMaxZoom = viewDuration <= MIN_VIEWPORT_MS;

  const focusViewportOnSpan = useCallback(
    (spanId: string) => {
      const span = trace.spans.find((s) => s.spanId === spanId);
      if (!span) return;

      const spanStart = getHighResInMs(span.startTime);
      const spanEnd = getHighResInMs(span.endTime);
      const spanDuration = spanEnd - spanStart;

      const rootS = root.startTime;
      const rootE = root.startTime + root.duration;
      const rootD = root.duration;

      if (spanDuration > rootD * 0.8) {
        animateTo({ start: rootS, end: rootE });
        return;
      }

      const padding = Math.max(spanDuration * 0.2, MIN_VIEWPORT_MS / 2);
      let newStart = spanStart - padding;
      let newEnd = spanEnd + padding;

      if (newEnd - newStart < MIN_VIEWPORT_MS) {
        const center = (spanStart + spanEnd) / 2;
        newStart = center - MIN_VIEWPORT_MS / 2;
        newEnd = center + MIN_VIEWPORT_MS / 2;
      }

      if (newStart < rootS) {
        const duration = newEnd - newStart;
        newStart = rootS;
        newEnd = Math.min(rootE, rootS + duration);
      }
      if (newEnd > rootE) {
        const duration = newEnd - newStart;
        newEnd = rootE;
        newStart = Math.max(rootS, rootE - duration);
      }

      animateTo({ start: newStart, end: newEnd });
    },
    [animateTo, trace.spans, root.startTime, root.duration]
  );

  // Bring a row into view when keyboard/button navigation lands on a span that
  // sits outside the shared scroll container's visible area. The list is
  // windowed, so an off-screen row has no DOM node to `scrollIntoView` —
  // `scrollRowIntoView` computes the target offset from the span's index.
  const scrollSpanIntoView = useCallback(
    (spanId: string) => {
      const index = trace.spans.findIndex((s) => s.spanId === spanId);
      if (index === -1) return;

      const list =
        scrollContainerRef.current?.querySelector<HTMLElement>('#event-list') ??
        null;
      scrollRowIntoView(list, index, ROW_HEIGHT_PX, {
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    },
    [trace.spans, reducedMotion]
  );

  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingZoom = useCallback(() => {
    if (zoomTimerRef.current !== null) {
      clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelPendingZoom, [cancelPendingZoom]);

  const handleClearActiveSpan = useCallback(() => {
    cancelPendingZoom();
    clearActiveSpan();
  }, [cancelPendingZoom, clearActiveSpan]);

  const handleSelectSpan = useCallback(
    (spanId: string) => {
      cancelPendingZoom();
      if (spanId === activeSpanId) {
        clearActiveSpan();
        return;
      }
      setActiveSpan(spanId);
      focusViewportOnSpan(spanId);
    },
    [
      cancelPendingZoom,
      activeSpanId,
      clearActiveSpan,
      setActiveSpan,
      focusViewportOnSpan,
    ]
  );

  const navigateToSpan = useCallback(
    (spanId: string) => {
      setActiveSpan(spanId);
      scrollSpanIntoView(spanId);
      cancelPendingZoom();
      zoomTimerRef.current = setTimeout(() => {
        zoomTimerRef.current = null;
        focusViewportOnSpan(spanId);
      }, ZOOM_DEBOUNCE_MS);
    },
    [setActiveSpan, scrollSpanIntoView, cancelPendingZoom, focusViewportOnSpan]
  );

  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        handleClearActiveSpan();
      } else if (e.key === 'Alt') {
        setAltHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = (): void => setAltHeld(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [handleClearActiveSpan]);

  const timelineRef = useRef<HTMLDivElement>(null);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);

  const hoverInfo = useMemo(() => {
    if (hoverFraction == null) return null;
    const absTime = viewport.start + hoverFraction * viewDuration;
    const offset = absTime - root.startTime;
    return { fraction: hoverFraction, label: formatDuration(offset, true) };
  }, [hoverFraction, viewport.start, viewDuration, root.startTime]);

  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = timelineRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const contentWidth = rect.width - TIMELINE_PADDING_PX * 2;
      if (contentWidth <= 0) return;
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (e.clientX - rect.left - TIMELINE_PADDING_PX) / contentWidth
        )
      );
      setHoverFraction(fraction);
    },
    []
  );

  const handleTimelineMouseLeave = useCallback(() => {
    setHoverFraction(null);
  }, []);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    const rootS = root.startTime;
    const rootE = root.startTime + root.duration;
    const rootD = root.duration;
    if (rootD <= 0) return;

    const onWheel = (e: WheelEvent): void => {
      const isZoomGesture = e.ctrlKey || e.metaKey;
      const hasDeltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY);

      if (!isZoomGesture && !hasDeltaX) return;
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const contentWidth = rect.width - TIMELINE_PADDING_PX * 2;
      if (contentWidth <= 0) return;

      if (isZoomGesture) {
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;

        const cursorFraction = Math.max(
          0,
          Math.min(
            1,
            (e.clientX - rect.left - TIMELINE_PADDING_PX) / contentWidth
          )
        );
        const isMouseWheel = e.deltaMode === 1 || Math.abs(e.deltaY) >= 50;
        const scaleFactor = 2 ** (dy / (isMouseWheel ? 200 : 60));

        setViewport((prev) => {
          const prevDuration = prev.end - prev.start;
          const cursorTime = prev.start + cursorFraction * prevDuration;
          const newDuration = Math.max(
            MIN_VIEWPORT_MS,
            Math.min(rootD, prevDuration * scaleFactor)
          );

          let newStart = cursorTime - cursorFraction * newDuration;
          let newEnd = newStart + newDuration;

          if (newStart < rootS) {
            newStart = rootS;
            newEnd = rootS + newDuration;
          }
          if (newEnd > rootE) {
            newEnd = rootE;
            newStart = Math.max(rootS, rootE - newDuration);
          }

          return { start: newStart, end: newEnd };
        });
      } else {
        let dx = e.deltaX;
        if (e.deltaMode === 1) dx *= 16;

        setViewport((prev) => {
          const prevDuration = prev.end - prev.start;
          const panAmount = (dx / contentWidth) * prevDuration;

          let newStart = prev.start + panAmount;
          let newEnd = prev.end + panAmount;

          if (newStart < rootS) {
            newStart = rootS;
            newEnd = rootS + prevDuration;
          }
          if (newEnd > rootE) {
            newEnd = rootE;
            newStart = Math.max(rootS, rootE - prevDuration);
          }

          return { start: newStart, end: newEnd };
        });
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [root.startTime, root.duration, setViewport]);

  return (
    <div
      ref={paneRootRef}
      data-pane="pane-root"
      className="relative flex w-full h-full max-h-full"
    >
      <div
        id="trace-parent"
        className="flex-1 min-w-0 grid grid-rows-[1fr] h-full min-h-0 overflow-hidden relative bg-background-100"
      >
        <SplitPane
          scrollContainerRef={scrollContainerRef}
          startHeader={
            <div className="bg-background-100 border-b border-gray-alpha-400 h-10 min-h-10 flex items-center pl-4 pr-2 gap-1.5">
              <Search className="w-3.5 h-3.5 shrink-0 text-gray-800" />
              <input
                id="trace-viewer-search"
                name="trace-viewer-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchQuery('');
                  }
                }}
                placeholder="Search spans..."
                aria-label="Search spans"
                className="flex-1 min-w-0 bg-transparent text-sm text-gray-1000 placeholder:text-gray-800 outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery('')}
                  className="-mr-2 hidden h-full max-w-full shrink-0 cursor-pointer items-center rounded-r-md border-0 bg-transparent px-2.5 font-inherit text-base text-gray-900 no-underline transition-colors duration-150 ease-in hover:text-gray-1000 focus-visible:-outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ds-focus-color)] min-[961px]:flex"
                >
                  <Kbd variant="outline" size="search">
                    Esc
                  </Kbd>
                </button>
              )}
            </div>
          }
          endHeader={
            <TimelineHeader markers={timeMarkers} hoverInfo={hoverInfo} />
          }
        >
          <div className="block overflow-visible">
            <EventList
              spans={trace.spans}
              activeSpanId={activeSpanId}
              searchResult={searchResult}
              onSelectSpan={handleSelectSpan}
            />
            <div ref={loadMoreSentinelRef} className="flex justify-center">
              {isLoadingMore ? (
                <div className="flex items-center justify-center gap-2 py-3 text-sm text-gray-800">
                  <Spinner size={14} />
                  <span>Loading spans…</span>
                </div>
              ) : null}
            </div>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: timeline hover and wheel gestures are pointer-only annotations */}
          <div
            ref={timelineRef}
            className="block min-h-0 overflow-visible relative"
            onDoubleClick={resetZoom}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
          >
            <Timeline
              spans={trace.spans}
              viewStart={viewport.start}
              viewEnd={viewport.end}
              markers={timeMarkers}
              selectedId={activeSpanId}
              searchResult={searchResult}
              onSelect={handleSelectSpan}
              onRevealTime={handleRevealTime}
              hoverFraction={hoverFraction}
              altHeld={altHeld}
            />
          </div>
        </SplitPane>
        <div className="absolute right-3 bottom-3 z-[5] flex items-center border border-gray-alpha-400 rounded-md bg-background-100 shadow-sm overflow-hidden divide-x divide-gray-alpha-400">
          <IconButton
            variant="muted"
            size="small"
            onClick={zoomOut}
            disabled={isAtMinZoom}
            aria-label="Zoom out"
          >
            <ZoomOut className="w-4 h-4" />
          </IconButton>
          <IconButton
            variant="muted"
            size="small"
            onClick={resetZoom}
            aria-label="Reset zoom"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            variant="muted"
            size="small"
            onClick={zoomIn}
            disabled={isAtMaxZoom}
            aria-label="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      <TraceDetailPanel
        containerRef={paneRootRef}
        onNavigateToSpan={navigateToSpan}
        onClose={handleClearActiveSpan}
      />

      <TraceShortcutHelper
        hasMultipleSpans={trace.spans.length > 1}
        reducedMotion={reducedMotion}
      />
    </div>
  );
}
