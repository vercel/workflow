import { useEffect, useRef } from 'react';

/**
 * Fires `loadMore` when a sentinel element scrolls into view.
 *
 * Attach the returned ref to an empty element placed after the list. The
 * observer only fires while `hasMore && !isLoadingMore`, and `loadMore` is
 * held in a ref so its identity changing does not re-create the observer.
 *
 * Pass the scrollable container as `root` when the list scrolls inside a
 * fixed-height element (rather than the viewport) so `rootMargin` prefetching
 * is measured against the container edge.
 */
export function useLoadMoreOnScroll(
  loadMore: () => void,
  {
    hasMore,
    isLoadingMore,
    root = null,
    rootMargin = '400px',
  }: {
    hasMore: boolean;
    isLoadingMore: boolean;
    root?: Element | null;
    rootMargin?: string;
  }
) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreRef.current();
            break;
          }
        }
      },
      { root, rootMargin, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, root, rootMargin]);

  return sentinelRef;
}
