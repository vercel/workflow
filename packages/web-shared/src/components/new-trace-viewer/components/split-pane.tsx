'use client';

import {
  Children,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn';
import { DraggableBorder } from './draggable-border';
import {
  DEFAULT_START_PX,
  GUTTER_PX,
  MIN_PX,
  paneColTemplate,
} from './pane-constants';
import { useElementWidth } from './use-element-width';

const SPLIT_PANE_START_ID = 'trace-split-start';

export interface SplitPaneProps {
  children: ReactNode;
  className?: string;
  startHeader?: ReactNode;
  endHeader?: ReactNode;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

export function SplitPane({
  children,
  className,
  startHeader,
  endHeader,
  scrollContainerRef,
}: SplitPaneProps) {
  const parts = Children.toArray(children);
  if (parts.length !== 2) {
    throw new Error('SplitPane expects exactly two children');
  }
  const [start, end] = parts;

  const [startPx, setStartPx] = useState(DEFAULT_START_PX);
  const containerRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementWidth(containerRef);

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (scrollContainerRef) {
        scrollContainerRef.current = node;
      }
    },
    [scrollContainerRef]
  );

  const clampPx = useCallback((px: number) => {
    const el = containerRef.current;
    if (!el) return px;
    const maxPx = el.getBoundingClientRect().width - MIN_PX - GUTTER_PX;
    return Math.min(maxPx, Math.max(MIN_PX, px));
  }, []);

  const handleWidthChange = useCallback(
    (next: number) => setStartPx(clampPx(next)),
    [clampPx]
  );
  const handleReset = useCallback(
    () => setStartPx(clampPx(DEFAULT_START_PX)),
    [clampPx]
  );

  const effectiveStartPx =
    containerWidth > 0
      ? Math.max(MIN_PX, Math.min(containerWidth - MIN_PX - GUTTER_PX, startPx))
      : startPx;

  const colTemplate = paneColTemplate(effectiveStartPx);

  const maxStartPx = Math.max(
    MIN_PX,
    containerWidth > 0 ? containerWidth - MIN_PX - GUTTER_PX : startPx
  );

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <div
        className="shrink-0 grid"
        style={{ gridTemplateColumns: colTemplate }}
      >
        <div>{startHeader}</div>
        <div className="flex justify-center">
          <span className="h-full w-px bg-gray-alpha-400" aria-hidden />
        </div>
        <div>{endHeader}</div>
      </div>
      <div
        ref={setContainerRef}
        className="grid flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
        style={{ gridTemplateColumns: colTemplate }}
      >
        <div ref={startRef} id={SPLIT_PANE_START_ID} className="min-w-0">
          {start}
        </div>
        <div className="relative z-20 isolate flex shrink-0 justify-center">
          <span
            className="pointer-events-none relative z-10 h-full w-px shrink-0 bg-gray-alpha-400"
            aria-hidden
          />
          <DraggableBorder
            element={startRef}
            position="right"
            onWidthChange={handleWidthChange}
            onReset={handleReset}
            aria-label="Resize event list"
            aria-controls={SPLIT_PANE_START_ID}
            aria-valuemin={MIN_PX}
            aria-valuemax={maxStartPx}
            aria-valuenow={Math.min(
              Math.max(Math.round(effectiveStartPx), MIN_PX),
              maxStartPx
            )}
          />
        </div>
        {end}
      </div>
    </div>
  );
}
