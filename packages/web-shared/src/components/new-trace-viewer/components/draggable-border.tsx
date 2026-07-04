'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn';

interface DraggableBorderProps {
  /** The panel whose width this border adjusts (measured on interaction). */
  element: RefObject<HTMLElement | null>;
  /** Which edge of the panel the border sits on. */
  position: 'left' | 'right';
  /**
   * Called with the next width (px) while dragging or keyboard-resizing.
   * The owner is responsible for clamping.
   */
  onWidthChange: (width: number) => void;
  /** Double-click reset. */
  onReset?: () => void;
  'aria-label': string;
  'aria-controls'?: string;
  'aria-valuemin'?: number;
  'aria-valuemax'?: number;
  'aria-valuenow'?: number;
}

/**
 * Overlay drag handle straddling a panel edge: an invisible strip over the
 * panel's border whose center line highlights on hover/drag, with
 * double-click reset, pointer-capture dragging (works with touch/pen, no
 * ghost image), and keyboard/ARIA window-splitter support.
 *
 * The panel's positioning ancestor must not clip overflow — the strip hangs
 * ~8px past the panel edge.
 */
export function DraggableBorder({
  element,
  position,
  onWidthChange,
  onReset,
  'aria-label': ariaLabel,
  'aria-controls': ariaControls,
  'aria-valuemin': ariaValueMin,
  'aria-valuemax': ariaValueMax,
  'aria-valuenow': ariaValueNow,
}: DraggableBorderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const pendingWidthRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  const lastDragEndAtRef = useRef(0);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Suppress text selection for the duration of a drag. Effect cleanup also
  // covers the handle unmounting mid-drag (e.g. Escape closing the panel).
  useEffect(() => {
    if (!isDragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [isDragging]);

  const stopDrag = () => {
    pointerIdRef.current = null;
    setIsDragging(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      // Flush the final position that was still waiting on the next frame.
      if (movedRef.current) onWidthChange(pendingWidthRef.current);
    }
    if (movedRef.current) {
      movedRef.current = false;
      lastDragEndAtRef.current = performance.now();
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Ignore secondary pointers (e.g. a second finger) while a drag is active
    // so they can't re-baseline the gesture.
    if (pointerIdRef.current !== null) return;
    const el = element.current;
    if (!el) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    startXRef.current = e.clientX;
    startWidthRef.current = el.offsetWidth;
    movedRef.current = false;
    setIsDragging(true);
  };

  // Pointer capture routes move/up events to the strip itself, so no
  // document-level listeners are needed.
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    if (Math.abs(e.clientX - startXRef.current) > 4) {
      movedRef.current = true;
    }
    const delta =
      position === 'left'
        ? startXRef.current - e.clientX
        : e.clientX - startXRef.current;
    pendingWidthRef.current = startWidthRef.current + delta;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        onWidthChange(pendingWidthRef.current);
      });
    }
  };

  const handlePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    stopDrag();
  };

  const handleLostPointerCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) {
      return;
    }
    stopDrag();
  };

  const handleDoubleClick = () => {
    // Pointer-capture drags still emit click/dblclick (unlike HTML5 drag), so
    // a dblclick during or right after a real drag is two resize nudges, not
    // a reset request.
    if (
      movedRef.current ||
      performance.now() - lastDragEndAtRef.current < 500
    ) {
      return;
    }
    onReset?.();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = element.current;
    if (!el) return;
    const step = e.shiftKey ? 64 : 16;
    // Arrows move the border in screen direction: for a left-edge border,
    // ArrowLeft grows the panel.
    const grow = position === 'left' ? 1 : -1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') {
      next = el.offsetWidth + grow * step;
    } else if (e.key === 'ArrowRight') {
      next = el.offsetWidth - grow * step;
    } else if (e.key === 'Home' && ariaValueMin !== undefined) {
      next = ariaValueMin;
    } else if (e.key === 'End' && ariaValueMax !== undefined) {
      next = ariaValueMax;
    }
    if (next === null) return;
    e.preventDefault();
    onWidthChange(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA window-splitter pattern requires a focusable div with role=separator; <hr> cannot receive focus or drag interactions
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      aria-valuenow={ariaValueNow}
      tabIndex={0}
      className={cn(
        'group absolute inset-y-0 z-10 w-[17px] cursor-col-resize touch-none outline-none',
        position === 'left' ? '-left-2' : '-right-2'
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handleLostPointerCapture}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Center line: sits exactly over the panel's 1px border and highlights
          on hover/drag/focus (delayed so incidental mouse-overs don't flash).
          pointer-events-none is load-bearing: without it this 1px line is a
          hit target, so a double-click aimed at the line lands one click on
          the line and (after sub-pixel jitter) the other on the strip. A
          native dblclick only fires when both clicks share a target, so the
          reset silently fails on the line but works just beside it. Keeping
          the line inert makes the separator div the sole target everywhere. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors delay-75 duration-100',
          'group-hover:bg-gray-500 group-focus-visible:bg-[var(--ds-focus-color)]',
          isDragging && 'bg-gray-500'
        )}
      />
    </div>
  );
}
