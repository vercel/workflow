'use client';

import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { useIntersectionObserver } from './use-intersection-observer';

interface UseLoadMoreOnScrollOptions {
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Scroll container the sentinel lives in. Defaults to the viewport. */
  rootRef?: RefObject<Element | null>;
  rootMargin?: string;
}

/**
 * Triggers `loadMore` when a sentinel element scrolls into view.
 * Returns a ref to attach to an invisible sentinel `<div>` placed after the
 * list content. Ported from vercel/front's `@vercel/hooks`
 * `useLoadMoreOnScroll`.
 *
 * Because it keys off `isIntersecting`/`isLoadingMore`, it self-continues:
 * if the sentinel is still in view once a page finishes loading, the next
 * page is requested automatically.
 */
export function useLoadMoreOnScroll(
  loadMore: () => void,
  {
    hasMore,
    isLoadingMore,
    rootRef,
    rootMargin = '400px',
  }: UseLoadMoreOnScrollOptions
) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entry = useIntersectionObserver(sentinelRef, { rootRef, rootMargin });

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  useEffect(() => {
    if (entry?.isIntersecting && hasMore && !isLoadingMore) {
      loadMoreRef.current();
    }
  }, [entry?.isIntersecting, hasMore, isLoadingMore]);

  return sentinelRef;
}
