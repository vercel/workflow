'use client';

import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
} from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPaginationDisplay } from '@/lib/utils';
import type { EnvMap } from './workflow-server-actions';
import {
  cancelRun as cancelRunServerAction,
  fetchEvents,
  fetchEventsByCorrelationId,
  fetchHook,
  fetchHooks,
  fetchRun,
  fetchRuns,
  fetchStep,
  fetchSteps,
  readStreamServerAction,
} from './workflow-server-actions';

const MAX_ITEMS = 1000;
const LIVE_POLL_LIMIT = 5;
const LIVE_UPDATE_INTERVAL_MS = 5000;

interface PageResult<T> {
  data: T[] | null;
  isLoading: boolean;
  error: Error | null;
}

interface PaginatedList<T> {
  data: PageResult<T>;
  allData: PageResult<T>[];
  error: Error | null;
  isLoading: boolean;
  currentPage: number;
  totalPages: number;
  nextPage: () => void;
  previousPage: () => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  reload: () => void;
  pageInfo: string;
}

/**
 * Returns a list of runs with pagination control
 */
export function useWorkflowRuns(
  env: EnvMap,
  params: {
    workflowName?: string;
    status?: WorkflowRunStatus;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
  }
): PaginatedList<WorkflowRun> {
  const { workflowName, status, limit = 10, sortOrder = 'desc' } = params;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageHistory, setPageHistory] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [maxPagesVisited, setMaxPagesVisited] = useState(1);

  // Store PageResult for each page
  const [allPageResults, setAllPageResults] = useState<
    Map<number, PageResult<WorkflowRun>>
  >(new Map([[0, { data: null, isLoading: true, error: null }]]));

  // Cache for fetched pages - key is cursor (or 'initial' for first page)
  const pageCache = useRef<
    Map<
      string,
      {
        data: WorkflowRun[];
        cursor?: string;
        hasMore: boolean;
      }
    >
  >(new Map());

  const fetchPage = useCallback(
    async (pageIndex: number, pageCursor?: string, force: boolean = false) => {
      const cacheKey = pageCursor ?? 'initial';

      // Set loading state for this page
      setAllPageResults((prev) => {
        const newMap = new Map(prev);
        newMap.set(pageIndex, {
          data: prev.get(pageIndex)?.data ?? null,
          isLoading: true,
          error: null,
        });
        return newMap;
      });

      // Check cache first unless force reload
      if (!force && pageCache.current.has(cacheKey)) {
        const cached = pageCache.current.get(cacheKey);
        if (cached) {
          setAllPageResults((prev) => {
            const newMap = new Map(prev);
            newMap.set(pageIndex, {
              data: cached.data,
              isLoading: false,
              error: null,
            });
            return newMap;
          });
          setCursor(cached.cursor);
          setHasMore(cached.hasMore);
          return;
        }
      }

      try {
        const result = await fetchRuns(env, {
          cursor: pageCursor,
          sortOrder,
          limit: limit,
          workflowName,
          status,
        });

        // Cache the result
        pageCache.current.set(cacheKey, {
          data: result.data,
          cursor: result.cursor,
          hasMore: result.hasMore,
        });

        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: result.data,
            isLoading: false,
            error: null,
          });
          return newMap;
        });
        setCursor(result.cursor);
        setHasMore(result.hasMore);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: prev.get(pageIndex)?.data ?? null,
            isLoading: false,
            error,
          });
          return newMap;
        });
      }
    },
    [env, workflowName, limit, sortOrder, status]
  );

  // Initial load
  // biome-ignore lint/correctness/useExhaustiveDependencies: Want to refetch first page on param change
  useEffect(() => {
    fetchPage(0, undefined, true);
  }, [fetchPage, sortOrder, env, limit, workflowName, status]);

  const nextPage = useCallback(() => {
    if (hasMore && cursor) {
      const newPage = currentPage + 1;

      setPageHistory((prev) => [...prev, cursor]);
      setCurrentPage(newPage);
      setMaxPagesVisited((prev) => Math.max(prev, newPage + 1));

      // Initialize next page if not already loaded
      if (!allPageResults.has(newPage)) {
        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(newPage, { data: null, isLoading: true, error: null });
          return newMap;
        });
      }

      fetchPage(newPage, cursor);
    }
  }, [hasMore, cursor, fetchPage, currentPage, allPageResults]);

  const previousPage = useCallback(() => {
    if (currentPage > 0) {
      const newPage = currentPage - 1;
      const prevCursor = pageHistory[newPage];

      setCurrentPage(newPage);
      fetchPage(newPage, prevCursor);
    }
  }, [currentPage, pageHistory, fetchPage]);

  const reload = useCallback(() => {
    // Clear cache and results
    pageCache.current.clear();
    setAllPageResults(
      new Map([[0, { data: null, isLoading: true, error: null }]])
    );
    // Reset to first page
    setCurrentPage(0);
    setPageHistory([undefined]);
    setMaxPagesVisited(1);
    // Force fetch first page
    fetchPage(0, undefined, true);
  }, [fetchPage]);

  const currentPageResult = allPageResults.get(currentPage) ?? {
    data: null,
    isLoading: true,
    error: null,
  };

  // Compute global error (any page has error)
  const globalError =
    Array.from(allPageResults.values()).find((p) => p.error)?.error ?? null;

  // Compute global loading (any page is loading)
  const globalLoading = Array.from(allPageResults.values()).some(
    (p) => p.isLoading
  );

  const totalPages = hasMore ? currentPage + 2 : currentPage + 1;
  const currentPageNumber = currentPage + 1;

  // Only show "+" if we're on the last visited page AND there are more pages
  const isOnLastVisitedPage = currentPageNumber === maxPagesVisited;
  const showPlus = isOnLastVisitedPage && hasMore;
  const pageInfo = getPaginationDisplay(
    currentPageNumber,
    maxPagesVisited,
    showPlus
  );

  return {
    data: currentPageResult,
    allData: Array.from(allPageResults.values()),
    error: globalError,
    isLoading: globalLoading,
    currentPage,
    totalPages,
    nextPage,
    previousPage,
    hasNextPage: hasMore,
    hasPreviousPage: currentPage > 0,
    reload,
    pageInfo,
  };
}

/**
 * Returns a list of hooks with pagination control
 */
export function useWorkflowHooks(
  env: EnvMap,
  params: {
    runId?: string;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
  }
): PaginatedList<Hook> {
  const { runId, limit = 10, sortOrder = 'desc' } = params;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageHistory, setPageHistory] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [maxPagesVisited, setMaxPagesVisited] = useState(1);

  // Store PageResult for each page
  const [allPageResults, setAllPageResults] = useState<
    Map<number, PageResult<Hook>>
  >(new Map([[0, { data: null, isLoading: true, error: null }]]));

  // Cache for fetched pages - key is cursor (or 'initial' for first page)
  const pageCache = useRef<
    Map<
      string,
      {
        data: Hook[];
        cursor?: string;
        hasMore: boolean;
      }
    >
  >(new Map());

  const fetchPage = useCallback(
    async (pageIndex: number, pageCursor?: string, force: boolean = false) => {
      const cacheKey = pageCursor ?? 'initial';

      // Set loading state for this page
      setAllPageResults((prev) => {
        const newMap = new Map(prev);
        newMap.set(pageIndex, {
          data: prev.get(pageIndex)?.data ?? null,
          isLoading: true,
          error: null,
        });
        return newMap;
      });

      // Check cache first unless force reload
      if (!force && pageCache.current.has(cacheKey)) {
        const cached = pageCache.current.get(cacheKey);
        if (cached) {
          setAllPageResults((prev) => {
            const newMap = new Map(prev);
            newMap.set(pageIndex, {
              data: cached.data,
              isLoading: false,
              error: null,
            });
            return newMap;
          });
          setCursor(cached.cursor);
          setHasMore(cached.hasMore);
          return;
        }
      }

      try {
        const result = await fetchHooks(env, {
          runId,
          cursor: pageCursor,
          sortOrder,
          limit: limit,
        });

        // Cache the result
        pageCache.current.set(cacheKey, {
          data: result.data,
          cursor: result.cursor,
          hasMore: result.hasMore,
        });

        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: result.data,
            isLoading: false,
            error: null,
          });
          return newMap;
        });
        setCursor(result.cursor);
        setHasMore(result.hasMore);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: prev.get(pageIndex)?.data ?? null,
            isLoading: false,
            error,
          });
          return newMap;
        });
      }
    },
    [env, runId, limit, sortOrder]
  );

  // Initial load
  useEffect(() => {
    fetchPage(0, undefined);
  }, [fetchPage]);

  const nextPage = useCallback(() => {
    if (hasMore && cursor) {
      const newPage = currentPage + 1;

      setPageHistory((prev) => [...prev, cursor]);
      setCurrentPage(newPage);
      setMaxPagesVisited((prev) => Math.max(prev, newPage + 1));

      // Initialize next page if not already loaded
      if (!allPageResults.has(newPage)) {
        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(newPage, { data: null, isLoading: true, error: null });
          return newMap;
        });
      }

      fetchPage(newPage, cursor);
    }
  }, [hasMore, cursor, fetchPage, currentPage, allPageResults]);

  const previousPage = useCallback(() => {
    if (currentPage > 0) {
      const newPage = currentPage - 1;
      const prevCursor = pageHistory[newPage];

      setCurrentPage(newPage);
      fetchPage(newPage, prevCursor);
    }
  }, [currentPage, pageHistory, fetchPage]);

  const reload = useCallback(() => {
    // Clear cache and results
    pageCache.current.clear();
    setAllPageResults(
      new Map([[0, { data: null, isLoading: true, error: null }]])
    );
    // Reset to first page
    setCurrentPage(0);
    setPageHistory([undefined]);
    setMaxPagesVisited(1);
    // Force fetch first page
    fetchPage(0, undefined, true);
  }, [fetchPage]);

  const currentPageResult = allPageResults.get(currentPage) ?? {
    data: null,
    isLoading: true,
    error: null,
  };

  // Compute global error (any page has error)
  const globalError =
    Array.from(allPageResults.values()).find((p) => p.error)?.error ?? null;

  // Compute global loading (any page is loading)
  const globalLoading = Array.from(allPageResults.values()).some(
    (p) => p.isLoading
  );

  const totalPages = hasMore ? currentPage + 2 : currentPage + 1;
  const currentPageNumber = currentPage + 1;

  // Only show "+" if we're on the last visited page AND there are more pages
  const isOnLastVisitedPage = currentPageNumber === maxPagesVisited;
  const showPlus = isOnLastVisitedPage && hasMore;
  const pageInfo = getPaginationDisplay(
    currentPageNumber,
    maxPagesVisited,
    showPlus
  );

  return {
    data: currentPageResult,
    allData: Array.from(allPageResults.values()),
    error: globalError,
    isLoading: globalLoading,
    currentPage,
    totalPages,
    nextPage,
    previousPage,
    hasNextPage: hasMore,
    hasPreviousPage: currentPage > 0,
    reload,
    pageInfo,
  };
}

// Helper function to exhaustively fetch steps
async function fetchAllSteps(
  env: EnvMap,
  runId: string
): Promise<{ data: Step[]; cursor?: string }> {
  let stepsData: Step[] = [];
  let stepsCursor: string | undefined;
  while (true) {
    const result = await fetchSteps(env, runId, {
      cursor: stepsCursor,
      sortOrder: 'asc',
      limit: 100,
    });

    stepsData = [...stepsData, ...result.data];
    if (!result.hasMore || !result.cursor || stepsData.length >= MAX_ITEMS) {
      break;
    }
    stepsCursor = result.cursor;
  }

  return { data: stepsData, cursor: stepsCursor };
}

// Helper function to exhaustively fetch hooks
async function fetchAllHooks(
  env: EnvMap,
  runId: string
): Promise<{ data: Hook[]; cursor?: string }> {
  let hooksData: Hook[] = [];
  let hooksCursor: string | undefined;
  while (true) {
    const result = await fetchHooks(env, {
      runId,
      cursor: hooksCursor,
      sortOrder: 'asc',
      limit: 100,
    });

    hooksData = [...hooksData, ...result.data];
    if (!result.hasMore || !result.cursor || hooksData.length >= MAX_ITEMS) {
      break;
    }
    hooksCursor = result.cursor;
  }

  return { data: hooksData, cursor: hooksCursor };
}

// Helper function to exhaustively fetch events
async function fetchAllEvents(
  env: EnvMap,
  runId: string
): Promise<{ data: Event[]; cursor?: string }> {
  let eventsData: Event[] = [];
  let eventsCursor: string | undefined;
  while (true) {
    const result = await fetchEvents(env, runId, {
      cursor: eventsCursor,
      sortOrder: 'asc',
      limit: 1000,
    });

    eventsData = [...eventsData, ...result.data];
    if (!result.hasMore || !result.cursor || eventsData.length >= MAX_ITEMS) {
      break;
    }
    eventsCursor = result.cursor;
  }

  return { data: eventsData, cursor: eventsCursor };
}

/**
 * Returns (and keeps up-to-date) all data related to a run.
 * Items returned will _not_ have resolved data (like input/output values).
 */
export function useWorkflowTraceViewerData(
  env: EnvMap,
  runId: string,
  options: { live?: boolean } = {}
) {
  const { live = false } = options;

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const [stepsCursor, setStepsCursor] = useState<string | undefined>();
  const [hooksCursor, setHooksCursor] = useState<string | undefined>();
  const [eventsCursor, setEventsCursor] = useState<string | undefined>();

  const isFetchingRef = useRef(false);
  const [initialLoadCompleted, setInitialLoadCompleted] = useState(false);

  // Fetch all data for a run
  const fetchAllData = useCallback(async () => {
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      // Fetch run
      const runData = await fetchRun(env, runId);
      setRun(runData);

      // TODO: Do these in parallel
      // Fetch steps exhaustively
      const stepsResult = await fetchAllSteps(env, runId);
      setSteps(stepsResult.data);
      setStepsCursor(stepsResult.cursor);

      // Fetch hooks exhaustively
      const hooksResult = await fetchAllHooks(env, runId);
      setHooks(hooksResult.data);
      setHooksCursor(hooksResult.cursor);

      // Fetch events exhaustively
      const eventsResult = await fetchAllEvents(env, runId);
      setEvents(eventsResult.data);
      setEventsCursor(eventsResult.cursor);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      setError(error);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
      setInitialLoadCompleted(true);
    }
  }, [env, runId]);

  // Helper to merge steps by ID
  const mergeSteps = useCallback((prev: Step[], newData: Step[]): Step[] => {
    const combined = [...prev, ...newData];
    const uniqueById = new Map(combined.map((s) => [(s as any).stepId, s]));
    return Array.from(uniqueById.values());
  }, []);

  // Helper to merge hooks by ID
  const mergeHooks = useCallback((prev: Hook[], newData: Hook[]): Hook[] => {
    const combined = [...prev, ...newData];
    const uniqueById = new Map(combined.map((h) => [(h as any).hookId, h]));
    return Array.from(uniqueById.values());
  }, []);

  // Helper to merge events by ID
  const mergeEvents = useCallback(
    (prev: Event[], newData: Event[]): Event[] => {
      const combined = [...prev, ...newData];
      const uniqueById = new Map(combined.map((e) => [(e as any).eventId, e]));
      return Array.from(uniqueById.values());
    },
    []
  );

  const pollRun = useCallback(async (): Promise<boolean> => {
    if (run?.completedAt) {
      return false;
    }
    const result = await fetchRun(env, runId);
    setRun(result);
    return true;
  }, [env, runId]);

  // Poll for new steps
  const pollSteps = useCallback(async (): Promise<boolean> => {
    const result = await fetchSteps(env, runId, {
      cursor: stepsCursor,
      sortOrder: 'asc',
      limit: LIVE_POLL_LIMIT,
    });
    if (result.data.length > 0) {
      setSteps((prev) => mergeSteps(prev, result.data));
      if (result.cursor) {
        setStepsCursor(result.cursor);
      }
      return true;
    }
    return false;
  }, [env, runId, stepsCursor, mergeSteps]);

  // Poll for new hooks
  const pollHooks = useCallback(async (): Promise<boolean> => {
    const result = await fetchHooks(env, {
      runId,
      cursor: hooksCursor,
      sortOrder: 'asc',
      limit: LIVE_POLL_LIMIT,
    });
    if (result.data.length > 0) {
      setHooks((prev) => mergeHooks(prev, result.data));
      if (result.cursor) {
        setHooksCursor(result.cursor);
      }
      return true;
    }

    return false;
  }, [env, runId, hooksCursor, mergeHooks]);

  // Poll for new events
  const pollEvents = useCallback(async (): Promise<boolean> => {
    const result = await fetchEvents(env, runId, {
      cursor: eventsCursor,
      sortOrder: 'asc',
      limit: LIVE_POLL_LIMIT,
    });
    if (result.data.length > 0) {
      setEvents((prev) => mergeEvents(prev, result.data));
      if (result.cursor) {
        setEventsCursor(result.cursor);
      }
      return true;
    }

    return false;
  }, [env, runId, eventsCursor, mergeEvents]);

  // Update function for live polling
  const update = useCallback(async (): Promise<{ foundNewItems: boolean }> => {
    if (isFetchingRef.current || !initialLoadCompleted) {
      return { foundNewItems: false };
    }

    let foundNewItems = false;

    pollRun();

    try {
      const [stepsUpdated, hooksUpdated, eventsUpdated] = await Promise.all([
        pollSteps(),
        pollHooks(),
        pollEvents(),
      ]);
      foundNewItems = stepsUpdated || hooksUpdated || eventsUpdated;
    } catch (err) {
      console.error('Update error:', err);
    }

    return { foundNewItems };
  }, [pollSteps, pollHooks, pollEvents, initialLoadCompleted, pollRun]);

  // Initial load
  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  // Live polling
  useEffect(() => {
    if (!live || !initialLoadCompleted || run?.completedAt) {
      return;
    }

    const interval = setInterval(() => {
      update();
    }, LIVE_UPDATE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [live, initialLoadCompleted, update, run?.completedAt]);

  return {
    run: run ?? ({} as WorkflowRun),
    steps,
    hooks,
    events,
    loading,
    error,
    update,
  };
}

// Helper function to fetch resource and get correlation ID
async function fetchResourceWithCorrelationId(
  env: EnvMap,
  resource: 'run' | 'step' | 'hook',
  resourceId: string,
  runId?: string
): Promise<{
  data: WorkflowRun | Step | Hook;
  correlationId: string;
}> {
  let resourceData: WorkflowRun | Step | Hook;
  let correlationId: string;

  if (resource === 'run') {
    resourceData = await fetchRun(env, resourceId);
    correlationId = (resourceData as WorkflowRun).runId;
  } else if (resource === 'step') {
    if (!runId) {
      throw new Error('runId is required for step resource');
    }
    resourceData = await fetchStep(env, runId, resourceId);
    correlationId = (resourceData as Step).stepId;
  } else if (resource === 'hook') {
    resourceData = await fetchHook(env, resourceId);
    correlationId = (resourceData as Hook).hookId;
  } else {
    throw new Error(`Unknown resource type: ${resource}`);
  }

  return { data: resourceData, correlationId };
}

// Helper function to exhaustively fetch events by correlation ID
async function fetchAllEventsByCorrelationId(
  env: EnvMap,
  correlationId: string,
  params?: {
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<Event[]> {
  const { sortOrder = 'asc', limit = 1000 } = params ?? {};

  let eventsData: Event[] = [];
  let cursor: string | undefined;
  while (true) {
    const result = await fetchEventsByCorrelationId(env, correlationId, {
      cursor: cursor,
      sortOrder: sortOrder,
      limit: limit,
    });

    eventsData = [...eventsData, ...result.data];
    if (!result.hasMore || !result.cursor || eventsData.length >= MAX_ITEMS) {
      break;
    }
    cursor = result.cursor;
  }

  return eventsData;
}

/**
 * Returns (and keeps up-to-date) data inherent to a specific run/step/hook,
 * resolving input/output/metadata, AND loading all related events with full event data.
 */
export function useWorkflowResourceData(
  env: EnvMap,
  resource: 'run' | 'step' | 'hook',
  resourceId: string,
  options: { refreshInterval?: number; runId?: string } = {}
) {
  const { refreshInterval = 0, runId } = options;

  const [data, setData] = useState<WorkflowRun | Step | Hook | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setData(null);
    setError(null);

    try {
      // Fetch resource with full data
      const { data: resourceData, correlationId } =
        await fetchResourceWithCorrelationId(env, resource, resourceId, runId);

      setData(resourceData);
      if (resource === 'run') {
        setLoading(false);
        return;
      }

      // Fetch events by correlation ID
      const eventsData = await fetchAllEventsByCorrelationId(
        env,
        correlationId
      );
      setEvents(eventsData);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      setError(error);
    } finally {
      setLoading(false);
    }
  }, [env, resource, resourceId, runId]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh interval
  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0) {
      return;
    }

    const interval = setInterval(fetchData, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval, fetchData]);

  return {
    data,
    events,
    loading,
    error,
    refresh: fetchData,
  };
}

/**
 * Cancel a workflow run
 */
export async function cancelRun(env: EnvMap, runId: string): Promise<void> {
  try {
    await cancelRunServerAction(env, runId);
  } catch (err) {
    console.error('Error canceling run:', err);
    throw err;
  }
}

export async function readStream(
  env: EnvMap,
  streamId: string,
  startIndex?: number
): Promise<ReadableStream<Uint8Array>> {
  try {
    const stream = await readStreamServerAction(env, streamId, startIndex);
    return stream;
  } catch (err) {
    console.error('Error reading stream:', err);
    throw err;
  }
}
