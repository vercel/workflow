'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Trace } from '../trace-viewer/types';
import { SplitPane } from './components/alt-split-pane';
import EventList from './components/event-list';
import { Timeline } from './components/timeline';
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

  const root = useMemo(() => computeRootBounds(trace.spans), [trace.spans]);

  const [viewport, setViewport] = useState<Viewport>({
    start: root.startTime,
    end: root.startTime + root.duration,
  });

  useEffect(() => {
    setViewport({ start: root.startTime, end: root.startTime + root.duration });
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
    setViewport({ start: root.startTime, end: root.startTime + root.duration });
  }, [root.startTime, root.duration]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        clearActiveSpan();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearActiveSpan]);

  const timelineRef = useRef<HTMLDivElement>(null);

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
      className="flex w-full h-full max-h-full"
      style={{
        display: 'grid',
        gridTemplateColumns: activeSpan
          ? 'minmax(100px, 1fr) 3px clamp(50px, 430px, 100%)'
          : 'minmax(100px, 1fr)',
        height: '100%',
      }}
    >
      <div
        id="trace-parent"
        className="grid grid-rows-[1fr] h-full min-h-0 overflow-hidden relative border border-gray-400 rounded-lg bg-background-100"
      >
        <SplitPane>
          <div className="block min-h-0 overflow-visible">
            <div className="sticky top-0 z-[4] bg-background-100 border-b border-gray-alpha-400 h-8 min-h-8" />
            <EventList
              spans={trace.spans}
              activeSpanId={activeSpanId}
              onSelectSpan={setActiveSpan}
            />
          </div>
          <div
            ref={timelineRef}
            className="block min-h-0 overflow-visible relative"
            onDoubleClick={resetZoom}
          >
            <Timeline
              spans={trace.spans}
              viewStart={viewport.start}
              viewDuration={viewDuration}
              rootStart={root.startTime}
              compression={compression}
              isZoomed={isZoomed}
              onResetZoom={resetZoom}
              selectedId={activeSpanId}
              onSelect={setActiveSpan}
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
