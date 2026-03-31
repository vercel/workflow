'use client';

import { Search, X } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Trace } from '../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../trace-viewer/util/timing';
import { SplitPane } from './components/split-pane';
import EventList from './components/event-list';
import { Timeline, TimelineHeader } from './components/timeline';
import { ActiveSpanProvider, useActiveSpan } from './context';
import { DetailPanel } from './detail-panel';
import { buildTimeCompression, computeRootBounds } from './utils';

interface NewTraceViewerProps {
  trace: Trace;
}

const MAX_ZOOM = 20;
const TIMELINE_PADDING = 16;

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

  const cancel = useCallback(() => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current.raf);
      animRef.current = null;
    }
  }, []);

  const animateTo = useCallback(
    (target: Viewport) => {
      cancel();
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
    [cancel]
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

export function NewTraceViewer({ trace }: NewTraceViewerProps): ReactNode {
  return (
    <ActiveSpanProvider spans={trace.spans}>
      <NewTraceViewerContent trace={trace} />
    </ActiveSpanProvider>
  );
}

function NewTraceViewerContent({ trace }: NewTraceViewerProps): ReactNode {
  const { activeSpan, activeSpanId, setActiveSpan, clearActiveSpan } =
    useActiveSpan();

  const [searchQuery, setSearchQuery] = useState('');

  const filteredSpans = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return trace.spans;
    return trace.spans.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.resource.toLowerCase().includes(q)
    );
  }, [trace.spans, searchQuery]);

  const root = useMemo(() => computeRootBounds(trace.spans), [trace.spans]);

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
  }, [root.startTime, root.duration]);

  const viewDuration = viewport.end - viewport.start;

  const compression = useMemo(
    () => buildTimeCompression(trace.spans, viewport.start, viewport.end),
    [trace.spans, viewport.start, viewport.end]
  );

  const isZoomed =
    viewport.start > root.startTime + 0.01 ||
    viewport.end < root.startTime + root.duration - 0.01;

  const resetZoom = useCallback(() => {
    animateTo({ start: root.startTime, end: root.startTime + root.duration });
  }, [animateTo, root.startTime, root.duration]);

  const handleSelectSpan = useCallback(
    (spanId: string) => {
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

      const padding = Math.max(spanDuration * 0.2, rootD / MAX_ZOOM / 2);
      let newStart = spanStart - padding;
      let newEnd = spanEnd + padding;

      const minViewport = Math.max(10, rootD / MAX_ZOOM);
      if (newEnd - newStart < minViewport) {
        const center = (spanStart + spanEnd) / 2;
        newStart = center - minViewport / 2;
        newEnd = center + minViewport / 2;
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
    [animateTo, setActiveSpan, trace.spans, root.startTime, root.duration]
  );

  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        clearActiveSpan();
      }
      if (e.key === 'Alt') {
        e.preventDefault();
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
  }, [clearActiveSpan]);

  const timelineRef = useRef<HTMLDivElement>(null);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);

  const hoverInfo = useMemo(() => {
    if (hoverFraction == null) return null;
    const absTime = compression.fromVisual(hoverFraction);
    const offset = absTime - root.startTime;
    return { fraction: hoverFraction, label: formatDuration(offset, true) };
  }, [hoverFraction, compression, root.startTime]);

  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = timelineRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const padding = 8;
      const contentWidth = rect.width - padding * 2;
      if (contentWidth <= 0) return;
      const fraction = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left - padding) / contentWidth)
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
      const contentWidth = rect.width - TIMELINE_PADDING * 2;
      if (contentWidth <= 0) return;

      if (isZoomGesture) {
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;

        const cursorFraction = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left - TIMELINE_PADDING) / contentWidth)
        );
        const scaleFactor = Math.pow(2, dy / 200);

        setViewport((prev) => {
          const prevDuration = prev.end - prev.start;
          const cursorTime = prev.start + cursorFraction * prevDuration;
          const minViewport = Math.max(10, rootD / MAX_ZOOM);
          const newDuration = Math.max(
            minViewport,
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
  }, [root.startTime, root.duration]);

  return (
    <div
      data-pane="pane-root"
      data-has-detail={activeSpan ? '' : undefined}
      className="grid w-full h-full max-h-full grid-cols-[minmax(100px,1fr)] data-[has-detail]:grid-cols-[minmax(100px,1fr)_clamp(50px,320px,100%)]"
    >
      <div
        id="trace-parent"
        className="grid grid-rows-[1fr] h-full min-h-0 overflow-hidden relative bg-background-100"
      >
        <SplitPane
          startHeader={
            <div className="bg-background-100 border-b border-gray-alpha-400 h-8 min-h-8 flex items-center px-2 gap-1.5">
              <Search className="w-3.5 h-3.5 shrink-0 text-gray-800" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search events..."
                className="flex-1 min-w-0 bg-transparent text-sm text-gray-1000 placeholder:text-gray-800 outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="shrink-0 p-0.5 rounded-sm text-gray-800 hover:text-gray-1000 hover:bg-gray-200 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          }
          endHeader={
            <TimelineHeader
              viewStart={viewport.start}
              viewDuration={viewDuration}
              rootStart={root.startTime}
              compression={compression}
              isZoomed={isZoomed}
              onResetZoom={resetZoom}
              hoverInfo={hoverInfo}
            />
          }
        >
          <div className="block min-h-0 overflow-visible">
            <EventList
              spans={filteredSpans}
              activeSpanId={activeSpanId}
              onSelectSpan={handleSelectSpan}
            />
          </div>
          <div
            ref={timelineRef}
            className="block min-h-0 overflow-visible relative px-2"
            onDoubleClick={resetZoom}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
          >
            <Timeline
              spans={filteredSpans}
              compression={compression}
              selectedId={activeSpanId}
              onSelect={handleSelectSpan}
              hoverFraction={hoverFraction}
              altHeld={altHeld}
            />
          </div>
        </SplitPane>
      </div>
      {activeSpan ? (
        <DetailPanel
          span={activeSpan}
          rootStart={root.startTime}
          onClose={clearActiveSpan}
        />
      ) : null}
    </div>
  );
}
