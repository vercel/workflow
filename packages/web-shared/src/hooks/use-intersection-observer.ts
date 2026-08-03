'use client';

import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

interface UseIntersectionObserverArgs
  extends Omit<IntersectionObserverInit, 'root'> {
  /**
   * Scroll container the target is observed within. Defaults to the viewport.
   * Passed as a ref so it resolves after commit (when the node exists).
   */
  rootRef?: RefObject<Element | null>;
  freezeOnceVisible?: boolean;
}

/**
 * Returns the latest IntersectionObserverEntry for `elementRef`.
 * Ported from vercel/front's `@vercel/hooks` `useIntersectionObserver`, with
 * `root` threaded as a ref so we can observe inside a custom scroll container.
 */
export function useIntersectionObserver(
  elementRef: RefObject<Element | null>,
  {
    threshold = 0,
    rootRef,
    rootMargin = '0%',
    freezeOnceVisible = false,
  }: UseIntersectionObserverArgs = {}
): IntersectionObserverEntry | undefined {
  const [entry, setEntry] = useState<IntersectionObserverEntry>();

  const frozen = entry?.isIntersecting && freezeOnceVisible;

  useEffect(() => {
    const node = elementRef?.current;

    const hasIOSupport = !!window.IntersectionObserver;

    if (!hasIOSupport || frozen || !node) return;

    const updateEntry = ([entry]: IntersectionObserverEntry[]): void => {
      setEntry(entry);
    };

    const observer = new IntersectionObserver(updateEntry, {
      threshold,
      root: rootRef?.current ?? null,
      rootMargin,
    });

    observer.observe(node);

    return () => observer.disconnect();
  }, [elementRef, threshold, rootRef, rootMargin, frozen]);

  return entry;
}
