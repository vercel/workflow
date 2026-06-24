'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLoadMoreOnScroll } from '../../hooks/use-load-more-on-scroll';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { filterSpanRawEvents } from '../../lib/trace-builder';
import { ErrorBoundary } from '../error-boundary';
import {
  EntityDetailPanel,
  type SelectedSpanInfo,
} from '../sidebar/entity-detail-panel';
import { useSidebarData } from '../sidebar/sidebar-data-context';
import { formatDuration, getHighResInMs } from '../trace-viewer/util/timing';
import { IconButton } from '../ui/icon-button';
import { Kbd } from '../ui/kbd';
import { Spinner } from '../ui/spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import EventList from './components/event-list';
import { TraceShortcutHelper } from './components/trace-shortcut-helper';
import { ROW_HEIGHT_PX, scrollRowIntoView } from './components/use-row-window';
import { SplitPane } from './components/split-pane';
import {
  TIMELINE_PADDING_PX,
  Timeline,
  TimelineHeader,
} from './components/timeline';
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

const ZOOM_ANIM_MS = 150;

/**
 * Drives the timeline viewport, animating zoom/pan transitions as a single
 * GPU-composited transform on the timeline's "zoom layer" instead of a
 * `setState`-per-frame tween.
 *
 * The committed `viewport` jumps straight to the target (one render, so bars
 * and gridlines reconcile exactly once per zoom). The visual transition is then
 * performed by seeding the layer with the inverse transform that maps the
 * freshly-rendered target back onto the currently-displayed view, and tweening
 * that transform to identity. Because the timeline maps time→x linearly, the
 * mapping is a 1-D affine transform `X' = a·X + b` (with `transform-origin` at
 * the content's left edge):
 *
 *   a = toDuration / fromDuration            (scaleX)
 *   b = (W / fromDuration) · (toStart − fromStart)   (translateX, px)
 *
 * where `W` is the content width in px. This collapses ~9 full-timeline
 * re-renders per zoom into a single render + a compositor animation.
 *
 * `rootRef` is the timeline's outer wrapper; the layer we transform is found
 * within it via its `data-zoom-layer` marker, so `Timeline` owns the element
 * and needs no extra prop.
 */
function useAnimatedViewport(
  initial: Viewport,
  rootRef: RefObject<HTMLElement | null>
) {
  const [viewport, setViewportState] = useState<Viewport>(initial);

  // The viewport currently *displayed*. During a transition this tracks the
  // interpolated value (the committed `viewport` is already at the target);
  // used as the `from` when a new animation interrupts a running one.
  const visualRef = useRef<Viewport>(initial);

  // Set by `animateTo` to request a tween; consumed once by the layout effect
  // after the target viewport has been committed to the DOM.
  const pendingFromRef = useRef<Viewport | null>(null);
  const rafRef = useRef(0);
  const reducedMotion = useReducedMotion();

  // The layer whose `transform` we drive imperatively. `transform` is NOT a
  // React-managed style on that element, so re-renders never clobber it.
  const getZoomLayer = useCallback(
    () =>
      rootRef.current?.querySelector<HTMLElement>('[data-zoom-layer]') ?? null,
    [rootRef]
  );

  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const clearTransform = useCallback(() => {
    const el = getZoomLayer();
    if (el) {
      el.style.transform = '';
      el.style.willChange = '';
    }
  }, [getZoomLayer]);

  const setViewport = useCallback(
    (update: Viewport | ((prev: Viewport) => Viewport)) => {
      stopRaf();
      pendingFromRef.current = null;
      clearTransform();
      setViewportState((prev) => {
        const next = typeof update === 'function' ? update(prev) : update;
        visualRef.current = next;
        return next;
      });
    },
    [stopRaf, clearTransform]
  );

  const animateTo = useCallback(
    (target: Viewport) => {
      stopRaf();
      if (reducedMotion) {
        pendingFromRef.current = null;
        clearTransform();
        visualRef.current = target;
        setViewportState(target);
        return;
      }
      // Commit the target now (a single render); the layout effect maps the
      // freshly-painted target back to the current visual viewport and tweens
      // the transform to identity.
      pendingFromRef.current = visualRef.current;
      setViewportState(target);
    },
    [stopRaf, clearTransform, reducedMotion]
  );

  // After the target viewport commits, before paint: seed the inverse transform
  // (no visible flash) and tween it to identity. Runs on every viewport change
  // but no-ops unless `animateTo` requested a transition.
  useLayoutEffect(() => {
    const from = pendingFromRef.current;
    pendingFromRef.current = null;
    const to = viewport;
    const el = getZoomLayer();
    if (!from || !el) {
      visualRef.current = to;
      return;
    }

    const contentWidth = el.clientWidth - TIMELINE_PADDING_PX * 2;
    const fromDuration = from.end - from.start;
    const toDuration = to.end - to.start;
    if (contentWidth <= 0 || fromDuration <= 0 || toDuration <= 0) {
      clearTransform();
      visualRef.current = to;
      return;
    }

    const scaleFrom = toDuration / fromDuration;
    const translateFrom =
      (contentWidth / fromDuration) * (to.start - from.start);

    // Nothing meaningful to animate — snap to the target.
    if (Math.abs(scaleFrom - 1) < 1e-4 && Math.abs(translateFrom) < 0.5) {
      clearTransform();
      visualRef.current = to;
      return;
    }

    el.style.willChange = 'transform';
    el.style.transform = `translateX(${translateFrom}px) scaleX(${scaleFrom})`;

    const startedAt = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - startedAt) / ZOOM_ANIM_MS, 1);
      const e = 1 - (1 - t) * (1 - t);
      const scale = scaleFrom + (1 - scaleFrom) * e;
      const translate = translateFrom * (1 - e);
      el.style.transform = `translateX(${translate}px) scaleX(${scale})`;
      visualRef.current = {
        start: from.start + (to.start - from.start) * e,
        end: from.end + (to.end - from.end) * e,
      };
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = 0;
        el.style.transform = '';
        el.style.willChange = '';
        visualRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return stopRaf;
  }, [viewport, stopRaf, clearTransform, getZoomLayer]);

  useEffect(() => stopRaf, [stopRaf]);

  return { viewport, setViewport, animateTo };
}

// ---------------------------------------------------------------------------
// Hook: bridge ActiveSpanContext + SidebarDataContext → SelectedSpanInfo
// ---------------------------------------------------------------------------

function useSelectedSpanInfo(): SelectedSpanInfo | null {
  const { activeSpan } = useActiveSpan();
  const sidebar = useSidebarData();

  return useMemo(() => {
    if (!activeSpan) return null;

    const resource = activeSpan.attributes?.resource as string | undefined;
    const rawEvents = filterSpanRawEvents(
      sidebar.events,
      resource,
      activeSpan.spanId
    );

    return {
      data: activeSpan.attributes?.data,
      resource,
      spanId: activeSpan.spanId,
      rawEvents,
    };
  }, [activeSpan, sidebar]);
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
  const { activeSpan, activeSpanId, setActiveSpan, clearActiveSpan } =
    useActiveSpan();

  const sidebar = useSidebarData();
  const selectedSpan = useSelectedSpanInfo();
  const reducedMotion = useReducedMotion();

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

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

  // Wrapper around the timeline; the zoom-transform layer lives within it and
  // is located via its `data-zoom-layer` marker.
  const timelineRef = useRef<HTMLDivElement>(null);

  const { viewport, setViewport, animateTo } = useAnimatedViewport(
    {
      start: root.startTime,
      end: root.startTime + root.duration,
    },
    timelineRef
  );

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
    const handleSidebarNavKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      const targetId =
        e.key === 'k' ? prevSpanIdRef.current : nextSpanIdRef.current;
      if (targetId) {
        e.preventDefault();
        navigateToSpanRef.current(targetId);
      }
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        handleClearActiveSpan();
      } else if (e.key === 'Alt') {
        setAltHeld(true);
      } else if (e.key === 'j' || e.key === 'k') {
        handleSidebarNavKey(e);
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

  // Derive the selected span name and metadata for the panel header
  const selectedSpanName = useMemo(() => {
    if (!selectedSpan?.data) return 'Details';
    const data = selectedSpan.data as Record<string, unknown>;
    if (selectedSpan.resource === 'hook') {
      return (data.token as string | undefined) ?? (data.hookId as string);
    }

    const stepName = data.stepName as string | undefined;
    const workflowName = data.workflowName as string | undefined;
    return (
      (stepName ? parseStepName(stepName)?.shortName : undefined) ??
      (workflowName ? parseWorkflowName(workflowName)?.shortName : undefined) ??
      stepName ??
      workflowName ??
      (data.hookId as string) ??
      'Details'
    );
  }, [selectedSpan?.data, selectedSpan?.resource]);

  const { prevSpanId, nextSpanId } = useMemo(() => {
    if (!activeSpanId) return { prevSpanId: null, nextSpanId: null };
    const i = trace.spans.findIndex((s) => s.spanId === activeSpanId);
    if (i === -1) return { prevSpanId: null, nextSpanId: null };
    return {
      prevSpanId: trace.spans[i - 1]?.spanId ?? null,
      nextSpanId: trace.spans[i + 1]?.spanId ?? null,
    };
  }, [activeSpanId, trace.spans]);

  const handleSelectPrevSpan = useCallback(() => {
    if (prevSpanId) navigateToSpan(prevSpanId);
  }, [prevSpanId, navigateToSpan]);

  const handleSelectNextSpan = useCallback(() => {
    if (nextSpanId) navigateToSpan(nextSpanId);
  }, [nextSpanId, navigateToSpan]);

  const prevSpanIdRef = useRef(prevSpanId);
  const nextSpanIdRef = useRef(nextSpanId);
  const navigateToSpanRef = useRef(navigateToSpan);
  prevSpanIdRef.current = prevSpanId;
  nextSpanIdRef.current = nextSpanId;
  navigateToSpanRef.current = navigateToSpan;

  return (
    <div
      data-pane="pane-root"
      data-has-detail={activeSpan ? '' : undefined}
      className="relative grid w-full h-full max-h-full grid-cols-[minmax(100px,1fr)] data-[has-detail]:grid-cols-[minmax(100px,1fr)_clamp(280px,360px,100%)]"
    >
      <div
        id="trace-parent"
        className="grid grid-rows-[1fr] h-full min-h-0 overflow-hidden relative bg-background-100"
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
            aria-label="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {/* Detail panel */}
      {activeSpan ? (
        <aside className="flex flex-col h-full max-h-full bg-background-100 border-l border-gray-alpha-400 overflow-auto">
          {/* Panel header */}
          <div className="flex items-center justify-between gap-2 shrink-0 px-4 pt-3 pb-3">
            <span className="text-label-14 font-medium text-gray-1000 truncate block">
              {selectedSpanName}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    aria-label="Navigate up"
                    aria-keyshortcuts="K"
                    onClick={handleSelectPrevSpan}
                    disabled={!prevSpanId}
                  >
                    <ChevronUp className="w-4 h-4" />
                  </IconButton>
                </TooltipTrigger>
                {prevSpanId ? (
                  <TooltipContent>
                    Navigate up
                    <Kbd>K</Kbd>
                  </TooltipContent>
                ) : null}
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    aria-label="Navigate down"
                    aria-keyshortcuts="J"
                    onClick={handleSelectNextSpan}
                    disabled={!nextSpanId}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </IconButton>
                </TooltipTrigger>
                {nextSpanId ? (
                  <TooltipContent>
                    Navigate down
                    <Kbd>J</Kbd>
                  </TooltipContent>
                ) : null}
              </Tooltip>
              <div aria-hidden className="w-px h-4 bg-gray-alpha-400 mx-1" />
              <IconButton
                aria-label="Close span details"
                aria-keyshortcuts="Escape"
                onClick={handleClearActiveSpan}
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
          {/* Panel body */}
          <div className="flex-1 overflow-y-auto">
            <ErrorBoundary>
              <EntityDetailPanel
                run={sidebar.run}
                onStreamClick={sidebar.onStreamClick}
                onRunClick={sidebar.onRunClick}
                spanDetailData={sidebar.spanDetailData}
                spanDetailError={sidebar.spanDetailError}
                spanDetailLoading={sidebar.spanDetailLoading}
                onSpanSelect={sidebar.onSpanSelect}
                onWakeUpSleep={sidebar.onWakeUpSleep}
                onLoadEventData={sidebar.onLoadEventData}
                onResolveHook={sidebar.onResolveHook}
                encryptionKey={sidebar.encryptionKey}
                onDecrypt={sidebar.onDecrypt}
                isDecrypting={sidebar.isDecrypting}
                selectedSpan={selectedSpan}
              />
            </ErrorBoundary>
          </div>
        </aside>
      ) : null}

      <TraceShortcutHelper
        hasMultipleSpans={trace.spans.length > 1}
        reducedMotion={reducedMotion}
      />
    </div>
  );
}
