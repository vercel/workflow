'use client';

import { type RefObject, useEffect, useState } from 'react';

/** Rows rendered on the first paint, before the container has been measured. */
const INITIAL_VISIBLE_ROWS = 60;

export interface RowWindow {
  /** First visible row index (inclusive), already padded by overscan. */
  start: number;
  /** Last visible row index (exclusive), already padded by overscan. */
  end: number;
}

/** Nearest scrollable ancestor of `el` (the shared `SplitPane` container). */
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Fixed-height windowing over a shared scroll container.
 *
 * The events list and timeline both render one `rowHeight`-tall row per span
 * and scroll together inside the same `SplitPane`. Each caller passes a ref to
 * its own root; the hook walks up to the shared scrollable ancestor, so the
 * scroll container doesn't have to be threaded through props. Same scroll
 * position + same row height means both panes window to the same range.
 */
export function useRowWindow(
  ref: RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
  overscan = 12
): RowWindow {
  // Bound the pre-measurement window so the first paint of a large trace
  // doesn't render every row before the effect narrows it down.
  const [range, setRange] = useState<RowWindow>(() => ({
    start: 0,
    end: Math.min(rowCount, INITIAL_VISIBLE_ROWS),
  }));

  useEffect(() => {
    const self = ref.current;
    const el = getScrollParent(self);
    if (!self || !el) return;

    let raf = 0;
    const measure = () => {
      raf = 0;
      // Offset of the list's top within the scroll container's content, so the
      // window stays correct even if the list isn't flush with the top.
      const offset =
        self.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop;
      const top = el.scrollTop - offset;
      const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
      const end = Math.min(
        rowCount,
        Math.ceil((top + el.clientHeight) / rowHeight) + overscan
      );
      setRange((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end }
      );
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, rowCount, rowHeight, overscan]);

  return range;
}

/** Row height (px) shared by the events list and timeline rows (`h-10`). */
export const ROW_HEIGHT_PX = 40;
