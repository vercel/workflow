'use client';

import {
  Children,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/utils';

/** Wide enough for comfortable dragging; visual line stays 1px centered. */
const GUTTER_PX = 9;

export function Divider() {
  return <div aria-hidden className="h-full w-px shrink-0 bg-gray-alpha-400" />;
}

export interface SplitPaneProps {
  children: ReactNode;
  className?: string;
  /** Initial width fraction for the first pane (0.15–0.85). */
  defaultRatio?: number;
  /** Fixed (non-scrolling) header rendered above the start pane. */
  startHeader?: ReactNode;
  /** Fixed (non-scrolling) header rendered above the end pane. */
  endHeader?: ReactNode;
}

function clampRatio(v: number) {
  return Math.min(0.85, Math.max(0.15, v));
}

function markUndoBaseline(
  initialRatioRef: RefObject<number | null>,
  splitRatio: number
) {
  if (initialRatioRef.current === null) initialRatioRef.current = splitRatio;
}

function handleSplitKeyboard(
  e: KeyboardEvent<HTMLDivElement>,
  splitRatio: number,
  initialRatioRef: RefObject<number | null>,
  setSplitRatio: Dispatch<SetStateAction<number>>
): void {
  const step = e.shiftKey ? 0.1 : 0.02;

  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    markUndoBaseline(initialRatioRef, splitRatio);
    setSplitRatio((r) => clampRatio(r - step));
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    markUndoBaseline(initialRatioRef, splitRatio);
    setSplitRatio((r) => clampRatio(r + step));
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    markUndoBaseline(initialRatioRef, splitRatio);
    setSplitRatio(0.15);
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    markUndoBaseline(initialRatioRef, splitRatio);
    setSplitRatio(0.85);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (initialRatioRef.current !== null) {
      setSplitRatio(initialRatioRef.current);
      initialRatioRef.current = null;
    }
  }
}

export function SplitPane({
  children,
  className,
  defaultRatio = 0.45,
  startHeader,
  endHeader,
}: SplitPaneProps) {
  const parts = Children.toArray(children);
  if (parts.length !== 2) {
    throw new Error('SplitPane expects exactly two children');
  }
  const [start, end] = parts;

  const [splitRatio, setSplitRatio] = useState(defaultRatio);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const innerGridRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRatio = useRef(defaultRatio);
  const pointerIdRef = useRef<number | null>(null);
  const initialRatioRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isDraggingSplit) return;

    const onPointerMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerIdRef.current) return;
      const container = innerGridRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      pendingRatio.current = clampRatio((e.clientX - rect.left) / rect.width);
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          setSplitRatio(pendingRatio.current);
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
      setIsDraggingSplit(false);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);

    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isDraggingSplit]);

  const handleSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    setIsDraggingSplit(true);
  };

  const handleLostPointerCapture = () => {
    pointerIdRef.current = null;
    setIsDraggingSplit(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const handleSplitKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    handleSplitKeyboard(e, splitRatio, initialRatioRef, setSplitRatio);
  };

  const ratioPercent = Math.round(splitRatio * 100);
  const colTemplate = `minmax(50px, ${splitRatio * 100}%) ${GUTTER_PX}px minmax(50px, ${(1 - splitRatio) * 100}%)`;

  const hasHeaders = startHeader != null || endHeader != null;

  const gutter = (
    <div
      ref={gutterRef}
      role="slider"
      aria-orientation="horizontal"
      aria-valuenow={ratioPercent}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuetext={`${ratioPercent}%`}
      tabIndex={0}
      className={cn(
        'relative z-20 isolate flex shrink-0 cursor-col-resize justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      onPointerDown={handleSplitPointerDown}
      onLostPointerCapture={handleLostPointerCapture}
      onKeyDown={handleSplitKeyDown}
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
          ref={innerGridRef}
          className={cn(
            'grid flex-1 min-h-0 content-start overflow-x-hidden overflow-y-auto',
            isDraggingSplit && 'select-none'
          )}
          style={{
            display: 'grid',
            gridTemplateColumns: colTemplate,
          }}
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
      ref={innerGridRef}
      className={cn(
        'grid h-full min-h-0 content-start overflow-x-hidden overflow-y-auto',
        isDraggingSplit && 'select-none',
        className
      )}
      style={{
        display: 'grid',
        gridTemplateColumns: colTemplate,
        height: '100%',
      }}
    >
      {start}
      {gutter}
      {end}
    </div>
  );
}
