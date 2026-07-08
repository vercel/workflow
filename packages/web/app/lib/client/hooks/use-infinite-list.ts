import type { WorkflowRun, WorkflowRunStatus } from '@workflow/world';
import { useCallback, useMemo } from 'react';
import useSWRInfinite from 'swr/infinite';
import {
  unwrapOrThrow,
  WorkflowWebAPIError,
} from '~/lib/client/workflow-errors';
import { fetchRuns } from '~/lib/rpc-client';
import type { AnalyticsPageInfo, EnvMap, PaginatedResult } from '~/lib/types';

export interface InfiniteList<T> {
  /** All rows accumulated so far, in fetch order (deduped by item key). */
  items: T[];
  error: Error | null;
  /** True while the first page is loading and no cached data is available. */
  isLoading: boolean;
  /** True while a subsequent page is being appended. */
  isLoadingMore: boolean;
  hasMore: boolean;
  /** Fetch the next page and append it. No-op while a fetch is in flight. */
  loadMore: () => void;
  /** Reset to the first page and revalidate it. */
  reload: () => void;
  /** Alias of reload — cached rows stay visible while revalidating. */
  refresh: () => void;
  /** Analytics window metadata from the first page response. */
  pageInfo?: AnalyticsPageInfo;
}

/**
 * Cursor-based infinite list backed by SWR's global cache.
 *
 * Pages are keyed by `[cacheKey, cursor]`, so switching tabs (unmount +
 * remount) restores previously fetched pages instantly instead of refetching.
 * Revalidation is deliberately conservative — analytics list queries can be
 * expensive (ClickHouse) — so cached pages are NOT refetched on remount or
 * when loading further pages (`revalidateFirstPage: false`,
 * `revalidateIfStale: false`). Freshness comes from explicit `reload()`/
 * `refresh()` calls (the Refresh button and the tab-visibility auto-reload).
 *
 * Rows are deduped by `getItemKey` when pages are flattened, so cursor drift
 * on live data cannot produce duplicate rows.
 */
export function useInfiniteList<T>(
  cacheKey: string,
  fetchFn: (cursor?: string) => Promise<PaginatedResult<T>>,
  getItemKey: (item: T) => string
): InfiniteList<T> {
  const getKey = useCallback(
    (
      _index: number,
      prev: PaginatedResult<T> | null
    ): [string, string | null] | null => {
      if (prev && (!prev.hasMore || !prev.cursor)) return null;
      return [cacheKey, prev?.cursor ?? null];
    },
    [cacheKey]
  );

  const {
    data: pages,
    error,
    isLoading,
    isValidating,
    size,
    setSize,
    mutate,
  } = useSWRInfinite<PaginatedResult<T>>(
    getKey,
    ([, cursor]: [string, string | null]) => fetchFn(cursor ?? undefined),
    {
      revalidateFirstPage: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      keepPreviousData: true,
    }
  );

  const items = useMemo(() => {
    if (!pages) return [];
    const seen = new Set<string>();
    const result: T[] = [];
    for (const page of pages) {
      for (const item of page.data) {
        const key = getItemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
      }
    }
    return result;
  }, [pages, getItemKey]);

  const lastPage = pages?.[pages.length - 1];
  const hasMore = Boolean(lastPage?.hasMore && lastPage?.cursor);
  // A further page has been requested but its data hasn't arrived yet.
  const isLoadingMore = size > 0 && Boolean(pages) && pages!.length < size;

  const loadMore = useCallback(() => {
    if (isValidating || !hasMore) return;
    void setSize((s) => s + 1);
  }, [isValidating, hasMore, setSize]);

  const reload = useCallback(() => {
    void setSize(1);
    void mutate();
  }, [setSize, mutate]);

  const normalizedError: Error | null = error
    ? error instanceof Error
      ? error
      : new WorkflowWebAPIError(String(error), { layer: 'client' })
    : null;

  return {
    items,
    error: normalizedError,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    reload,
    refresh: reload,
    pageInfo: pages?.[0]?.pageInfo,
  };
}

/**
 * Infinite-scrolling list of workflow runs.
 *
 * Pages are larger than the old prev/next views (25 rows) since rows
 * accumulate; with the ClickHouse-backed analytics read path this keeps the
 * number of round-trips low while scrolling.
 */
export function useWorkflowRunsInfinite(
  env: EnvMap,
  params: {
    workflowName?: string;
    status?: WorkflowRunStatus;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
    /**
     * Optional listing window (ISO timestamps, both required together).
     * Callers should freeze the window per selection/refresh so every page
     * of one list shares the same bounds. Honored on the analytics read
     * path; windows beyond the plan lookback surface as a 402
     * `observability-upgrade-required` error.
     */
    startTime?: string;
    endTime?: string;
  }
): InfiniteList<WorkflowRun> {
  const {
    workflowName,
    status,
    limit = 25,
    sortOrder = 'desc',
    startTime,
    endTime,
  } = params;

  const cacheKey = `workflow-runs:${workflowName ?? ''}:${status ?? ''}:${sortOrder}:${limit}:${startTime ?? ''}:${endTime ?? ''}`;

  const fetchFn = useCallback(
    (cursor?: string) =>
      unwrapOrThrow(
        fetchRuns(env, {
          cursor,
          sortOrder,
          limit,
          workflowName,
          status,
          startTime,
          endTime,
        })
      ),
    [env, workflowName, limit, sortOrder, status, startTime, endTime]
  );

  const getItemKey = useCallback((run: WorkflowRun) => run.runId, []);

  return useInfiniteList(cacheKey, fetchFn, getItemKey);
}
