'use client';

import {
  Children,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn';
import {
  DEFAULT_START_PX,
  GUTTER_PX,
  MIN_PX,
  paneColTemplate,
} from './pane-constants';
import { useElementWidth } from './use-element-width';

export interface SplitPaneProps {
  children: ReactNode;
  className?: string;
  /** Fixed (non-scrolling) header rendered above the start pane. */
  startHeader?: ReactNode;
  /** Fixed (non-scrolling) header rendered above the end pane. */
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

  // `startPx` is the user's preferred width; the rendered width is derived by
  // clamping against the live container width (same model as the detail
  // panel), so shrinking the container compresses the pane without destroying
  // the preference, and re-growing restores it.
  const [startPx, setStartPx] = useState(DEFAULT_START_PX);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingPx = useRef(DEFAULT_START_PX);
  const pointerIdRef = useRef<number | null>(null);
  const containerWidth = useElementWidth(containerRef);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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

  useEffect(() => {
    if (!isDragging) return;

    const onPointerMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerIdRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      pendingPx.current = clampPx(e.clientX - rect.left);
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          setStartPx(pendingPx.current);
        });
      }
    };

    const onPointerUp = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerIdRef.current) return;
      const gutter = gutterRef.current;
      if (gutter?.hasPointerCapture(e.pointerId)) {
        gutter.releasePointerCapture(e.pointerId);
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pointerIdRef.current = null;
      setIsDragging(false);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);

    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isDragging, clampPx]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    setIsDragging(true);
  };

  const handleLostPointerCapture = () => {
    pointerIdRef.current = null;
    setIsDragging(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  // Floor applied last so the start column can never collapse below MIN_PX
  // (which would produce an invalid negative grid track on tiny containers).
  const effectiveStartPx =
    containerWidth > 0
      ? Math.max(MIN_PX, Math.min(containerWidth - MIN_PX - GUTTER_PX, startPx))
      : startPx;

  const colTemplate = paneColTemplate(effectiveStartPx);

  const gutter = (
    <div
      ref={gutterRef}
      className="relative z-20 isolate flex shrink-0 cursor-col-resize justify-center"
      onPointerDown={handlePointerDown}
      onLostPointerCapture={handleLostPointerCapture}
    >
      <span
        className="pointer-events-none relative z-10 h-full w-px shrink-0 bg-gray-alpha-400"
        aria-hidden
      />
    </div>
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
        className={cn(
          'grid flex-1 min-h-0 overflow-x-hidden overflow-y-auto',
          isDragging && 'select-none'
        )}
        style={{ gridTemplateColumns: colTemplate }}
      >
        {start}
        {gutter}
        {end}
      </div>
    </div>
  );
}
