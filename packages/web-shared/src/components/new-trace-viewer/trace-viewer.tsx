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
  useCallback,
  useDeferredValue,
  useEffect,
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

  const timeMarkers = useMemo(
    () => computeTimeMarkers(viewDuration, viewport.start - root.startTime),
    [viewDuration, viewport.start, root.startTime]
  );

  const resetZoom = useCallback(() => {
    animateTo({ start: root.startTime, end: root.startTime + root.duration });
  }, [animateTo, root.startTime, root.duration]);

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

  const handleSelectSpan = useCallback(
    (spanId: string) => {
      if (spanId === activeSpanId) {
        clearActiveSpan();
        return;
      }
      setActiveSpan(spanId);

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
    [
      animateTo,
      setActiveSpan,
      clearActiveSpan,
      activeSpanId,
      trace.spans,
      root.startTime,
      root.duration,
    ]
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
        handleSelectSpanRef.current(targetId);
      }
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        clearActiveSpan();
      } else if (e.key === 'Alt') {
        e.preventDefault();
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
  }, [clearActiveSpan]);

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
    if (prevSpanId) handleSelectSpan(prevSpanId);
  }, [prevSpanId, handleSelectSpan]);

  const handleSelectNextSpan = useCallback(() => {
    if (nextSpanId) handleSelectSpan(nextSpanId);
  }, [nextSpanId, handleSelectSpan]);

  const prevSpanIdRef = useRef(prevSpanId);
  const nextSpanIdRef = useRef(nextSpanId);
  const handleSelectSpanRef = useRef(handleSelectSpan);
  prevSpanIdRef.current = prevSpanId;
  nextSpanIdRef.current = nextSpanId;
  handleSelectSpanRef.current = handleSelectSpan;

  return (
    <div
      data-pane="pane-root"
      data-has-detail={activeSpan ? '' : undefined}
      className="grid w-full h-full max-h-full grid-cols-[minmax(100px,1fr)] data-[has-detail]:grid-cols-[minmax(100px,1fr)_clamp(280px,360px,100%)]"
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
                  <kbd className="inline-flex h-5 min-h-5 min-w-5 items-center justify-center rounded border border-gray-alpha-400 bg-background-100 px-1 font-sans text-[13px] font-medium leading-[1.7em] text-gray-900">
                    Esc
                  </kbd>
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
                onClick={clearActiveSpan}
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
    </div>
  );
}
