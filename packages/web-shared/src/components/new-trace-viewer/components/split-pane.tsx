'use client';

import {
  Children,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/utils';

const GUTTER_PX = 1;
const MIN_PX = 50;
const DEFAULT_START_PX = 340;

export function Divider() {
  return <div aria-hidden className="h-full w-px shrink-0 bg-gray-alpha-400" />;
}

export interface SplitPaneProps {
  children: ReactNode;
  className?: string;
  /** Fixed pixel width for the start (left) pane. Default 220. */
  defaultStartWidth?: number;
  /** Fixed (non-scrolling) header rendered above the start pane. */
  startHeader?: ReactNode;
  /** Fixed (non-scrolling) header rendered above the end pane. */
  endHeader?: ReactNode;
}

export function SplitPane({
  children,
  className,
  defaultStartWidth = DEFAULT_START_PX,
  startHeader,
  endHeader,
}: SplitPaneProps) {
  const parts = Children.toArray(children);
  if (parts.length !== 2) {
    throw new Error('SplitPane expects exactly two children');
  }
  const [start, end] = parts;

  const [startPx, setStartPx] = useState(defaultStartWidth);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingPx = useRef(defaultStartWidth);
  const pointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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

  const colTemplate = `${startPx}px ${GUTTER_PX}px minmax(${MIN_PX}px, 1fr)`;
  const hasHeaders = startHeader != null || endHeader != null;

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

  if (hasHeaders) {
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
          ref={containerRef}
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

  return (
    <div
      ref={containerRef}
      className={cn(
        'grid h-full min-h-0 content-start overflow-x-hidden overflow-y-auto',
        isDragging && 'select-none',
        className
      )}
      style={{ gridTemplateColumns: colTemplate, height: '100%' }}
    >
      {start}
      {gutter}
      {end}
    </div>
  );
}
