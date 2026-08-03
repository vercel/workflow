'use client';

import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * Observed width (px) of `ref`'s element. Measures synchronously before paint
 * when (re-)enabled, then tracks resizes. While disabled it keeps the last
 * measured value; re-enabling re-measures before the next paint.
 */
export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
  enabled = true
): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry?.contentRect.width ?? 0));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);

  return width;
}
