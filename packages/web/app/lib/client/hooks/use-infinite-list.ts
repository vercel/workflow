import type { WorkflowRun, WorkflowRunStatus } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  unwrapOrThrow,
  WorkflowWebAPIError,
} from '~/lib/client/workflow-errors';
import { fetchRuns } from '~/lib/rpc-client';
import type { AnalyticsPageInfo, EnvMap, PaginatedResult } from '~/lib/types';

export interface InfiniteList<T> {
  /** All rows accumulated so far, in fetch order. */
  items: T[];
  error: Error | null;
  /** True while the first page (or a full reload) is loading. */
  isLoading: boolean;
  /** True while a subsequent page is being appended. */
  isLoadingMore: boolean;
  hasMore: boolean;
  /** Fetch the next page and append it. No-op while a fetch is in flight. */
  loadMore: () => void;
  /** Clear accumulated rows and refetch from the top (shows the loading state). */
  reload: () => void;
  /**
   * Refetch from the top while keeping current rows visible until data
   * arrives (prevents flicker for poll-style refreshes).
   */
  refresh: () => void;
  /** Analytics window metadata from the most recent first-page response. */
  pageInfo?: AnalyticsPageInfo;
}

/**
 * Cursor-based infinite list: accumulates pages into a flat array.
 *
 * Unlike `usePaginatedList` (page-at-a-time prev/next), each `loadMore`
 * fetches only the next page via the server cursor and appends it, deduped
 * by `getItemKey` so cursor drift on live data cannot produce duplicate rows.
 *
 * Callers should memoize `fetchFn` with useCallback; a `fetchFn` identity
 * change (i.e. filter/sort params changed) resets the list and refetches.
 */
export function useInfiniteList<T>(
  fetchFn: (cursor?: string) => Promise<PaginatedResult<T>>,
  getItemKey: (item: T) => string
): InfiniteList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [pageInfo, setPageInfo] = useState<AnalyticsPageInfo | undefined>(
    undefined
  );
  const [error, setError] = useState<Error | null>(null);
  // Initial isLoading is false so SSR and client hydration agree; the mount
  // effect sets it to true when the first fetch starts on the client.
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const cursorRef = useRef<string | undefined>(undefined);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);
  // Bumped on every reset; in-flight responses from an older generation are
  // discarded so a reload during a fetch cannot interleave stale rows.
  const generationRef = useRef(0);

  const getItemKeyRef = useRef(getItemKey);
  useEffect(() => {
    getItemKeyRef.current = getItemKey;
  }, [getItemKey]);

  const toError = (err: unknown): Error =>
    err instanceof Error
      ? err
      : new WorkflowWebAPIError(String(err), { layer: 'client' });

  const fetchFirstPage = useCallback(
    async (opts: { showLoading: boolean }) => {
      const generation = ++generationRef.current;
      inFlightRef.current = true;
      if (opts.showLoading) {
        setIsLoading(true);
      }
      setError(null);
      try {
        const result = await fetchFn(undefined);
        if (generation !== generationRef.current) return;
        cursorRef.current = result.cursor;
        seenKeysRef.current = new Set(result.data.map(getItemKeyRef.current));
        setItems(result.data);
        setHasMore(result.hasMore && Boolean(result.cursor));
        setPageInfo(result.pageInfo);
      } catch (err) {
        if (generation !== generationRef.current) return;
        setError(toError(err));
      } finally {
        if (generation === generationRef.current) {
          inFlightRef.current = false;
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [fetchFn]
  );

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !cursorRef.current) return;
    const generation = generationRef.current;
    inFlightRef.current = true;
    setIsLoadingMore(true);
    try {
      const result = await fetchFn(cursorRef.current);
      if (generation !== generationRef.current) return;
      cursorRef.current = result.cursor;
      const fresh = result.data.filter(
        (item) => !seenKeysRef.current.has(getItemKeyRef.current(item))
      );
      for (const item of fresh) {
        seenKeysRef.current.add(getItemKeyRef.current(item));
      }
      if (fresh.length > 0) {
        setItems((prev) => [...prev, ...fresh]);
      }
      setHasMore(result.hasMore && Boolean(result.cursor));
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(toError(err));
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [fetchFn]);

  // Initial load, and reset + refetch whenever fetchFn identity changes
  // (filters / sort order changed).
  useEffect(() => {
    cursorRef.current = undefined;
    seenKeysRef.current = new Set();
    setItems([]);
    setHasMore(false);
    fetchFirstPage({ showLoading: true });
  }, [fetchFirstPage]);

  const reload = useCallback(() => {
    cursorRef.current = undefined;
    seenKeysRef.current = new Set();
    setItems([]);
    setHasMore(false);
    fetchFirstPage({ showLoading: true });
  }, [fetchFirstPage]);

  const refresh = useCallback(() => {
    cursorRef.current = undefined;
    fetchFirstPage({ showLoading: false });
  }, [fetchFirstPage]);

  return {
    items,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    reload,
    refresh,
    pageInfo,
  };
}

/**
 * Infinite-scrolling list of workflow runs.
 *
 * Pages are larger than the prev/next views (25 rows) since rows accumulate;
 * with the ClickHouse-backed analytics read path this keeps the number of
 * round-trips low while scrolling.
 */
export function useWorkflowRunsInfinite(
  env: EnvMap,
  params: {
    workflowName?: string;
    status?: WorkflowRunStatus;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
  }
): InfiniteList<WorkflowRun> {
  const { workflowName, status, limit = 25, sortOrder = 'desc' } = params;

  const fetchFn = useCallback(
    (cursor?: string) =>
      unwrapOrThrow(
        fetchRuns(env, { cursor, sortOrder, limit, workflowName, status })
      ),
    [env, workflowName, limit, sortOrder, status]
  );

  return useInfiniteList(fetchFn, (run) => run.runId);
}
