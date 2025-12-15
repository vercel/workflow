'use client';

import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
} from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPaginationDisplay } from '../lib/utils';
import type { EnvMap, ServerActionError } from './workflow-server-actions';
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
  fetchStreams,
  readStreamServerAction,
  recreateRun as recreateRunServerAction,
  wakeUpRun as wakeUpRunServerAction,
  type StopSleepOptions,
  type StopSleepResult,
  reenqueueRun as reenqueueRunServerAction,
} from './workflow-server-actions';

const MAX_ITEMS = 1000;
const LIVE_POLL_LIMIT = 10;
const LIVE_STEP_UPDATE_INTERVAL_MS = 2000;
const LIVE_UPDATE_INTERVAL_MS = 5000;

/**
 * Helper to convert ServerActionError to WorkflowWebAPIError
 */
function createWorkflowAPIError(
  serverError: ServerActionError
): WorkflowWebAPIError {
  return new WorkflowWebAPIError(serverError.message, {
    cause: serverError.cause,
    request: serverError.request,
    layer: serverError.layer,
  });
}

/**
 * Gets a user-facing error message from an error object.
 * Handles both WorkflowWebAPIError and regular Error instances.
 */
export const getErrorMessage = (error: Error | WorkflowWebAPIError): string => {
  if ('layer' in error && error.layer) {
    if (error instanceof WorkflowWebAPIError) {
      if (error.request?.status === 403) {
        return 'Your current Vercel account does not have access to this data. Please use `vercel login` to log in, or use `vercel switch` to ensure you can access the correct team.';
      }
    }

    // WorkflowWebAPIError already has user-facing messages
    return error.message;
  }

  return error instanceof Error ? error.message : 'An error occurred';
};

/**
 * Helper to handle server action results and throw WorkflowWebAPIError on failure
 */
export async function unwrapServerActionResult<T>(
  promise: Promise<{
    success: boolean;
    data?: T;
    error?: ServerActionError;
  }>
): Promise<
  { error: WorkflowWebAPIError; result: null } | { error: null; result: T }
> {
  let result: { success: boolean; data?: T; error?: ServerActionError };
  try {
    result = await promise;
  } catch (error) {
    result = {
      success: false,
      error: error as ServerActionError,
    };
  }
  if (!result.success) {
    console.error('[web-api-client] error', result.error);
    if (!result.error) {
      return {
        error: new WorkflowWebAPIError('Unknown error occurred', {
          layer: 'client',
        }),
        result: null,
      };
    }
    return {
      error: createWorkflowAPIError(result.error),
      result: null,
    };
  }
  return { error: null, result: result.data as T };
}

/**
 *  Error instance for API and server-side errors.
 * `error.message` will be a user-facing error message, to be displayed in UI.
 * `error.cause` will be a developer-facing error message, to be displayed in logs.
 *
 *  If the error originates from an HTTP request made from a server action,
 *  these fields will be populated:
 *  - `error.request` will be a JSON-serializable object representing the request made.
 *  - `error.layer` will be 'API'
 *
 *  If the error originates from inside the server action, or there's an error with
 *  calling the server action, these fields will be populated:
 *  - `error.layer` will be 'server'
 */
export class WorkflowWebAPIError extends Error {
  request?: any;
  layer?: 'client' | 'server' | 'API';
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      request?: any;
      layer?: 'client' | 'server' | 'API';
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'WorkflowWebAPIError';
    this.request = options?.request;
    this.layer = options?.layer;
    if (options?.cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }
}

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

      const { error, result } = await unwrapServerActionResult(
        fetchRuns(env, {
          cursor: pageCursor,
          sortOrder,
          limit: limit,
          workflowName,
          status,
        })
      );

      if (error) {
        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: prev.get(pageIndex)?.data ?? null,
            isLoading: false,
            error,
          });
          return newMap;
        });
        return;
      }

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

      const { error, result } = await unwrapServerActionResult(
        fetchHooks(env, {
          runId,
          cursor: pageCursor,
          sortOrder,
          limit: limit,
        })
      );

      if (error) {
        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: prev.get(pageIndex)?.data ?? null,
            isLoading: false,
            error,
          });
          return newMap;
        });
        return;
      }

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
    const { error, result } = await unwrapServerActionResult(
      fetchSteps(env, runId, {
        cursor: stepsCursor,
        sortOrder: 'asc',
        limit: 100,
      })
    );
    // TODO: We're not handling errors well for infinite fetches
    if (error) {
      break;
    }

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
    const { error, result } = await unwrapServerActionResult(
      fetchHooks(env, {
        runId,
        cursor: hooksCursor,
        sortOrder: 'asc',
        limit: 100,
      })
    );
    if (error) {
      break;
    }

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
    const { error, result } = await unwrapServerActionResult(
      fetchEvents(env, runId, {
        cursor: eventsCursor,
        sortOrder: 'asc',
        limit: 1000,
      })
    );

    if (error) {
      break;
    }

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
  const [auxiliaryDataLoading, setAuxiliaryDataLoading] = useState(false);
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
    setAuxiliaryDataLoading(true);
    setError(null);

    const promises = [
      unwrapServerActionResult(fetchRun(env, runId)).then(
        ({ error, result }) => {
          if (error) {
            setError(error);
            return;
          }
          setRun(result);
          return result;
        }
      ),
      fetchAllSteps(env, runId).then((result) => {
        setSteps(result.data);
        setStepsCursor(result.cursor);
      }),
      fetchAllHooks(env, runId).then((result) => {
        setHooks(result.data);
        setHooksCursor(result.cursor);
      }),
      fetchAllEvents(env, runId).then((result) => {
        setEvents(result.data);
        setEventsCursor(result.cursor);
      }),
    ];

    const results = await Promise.allSettled(promises);
    setLoading(false);
    setAuxiliaryDataLoading(false);
    setInitialLoadCompleted(true);
    isFetchingRef.current = false;
    // Just doing the first error, but would be nice to show multiple
    const error = results.find((result) => result.status === 'rejected')
      ?.reason as Error;
    if (error) {
      setError(error);
      return;
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
    const { error, result } = await unwrapServerActionResult(
      fetchRun(env, runId)
    );
    if (error) {
      setError(error);
      return false;
    }
    setRun(result);
    return true;
  }, [env, runId, run?.completedAt]);

  // Poll for new steps
  const pollSteps = useCallback(async (): Promise<boolean> => {
    const { error, result } = await unwrapServerActionResult(
      fetchSteps(env, runId, {
        cursor: stepsCursor,
        sortOrder: 'asc',
        limit: LIVE_POLL_LIMIT,
      })
    );
    if (error) {
      setError(error);
      return false;
    }

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
    const { error, result } = await unwrapServerActionResult(
      fetchHooks(env, {
        runId,
        cursor: hooksCursor,
        sortOrder: 'asc',
        limit: LIVE_POLL_LIMIT,
      })
    );
    if (error) {
      setError(error);
      return false;
    }
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
    const { error, result } = await unwrapServerActionResult(
      fetchEvents(env, runId, {
        cursor: eventsCursor,
        sortOrder: 'asc',
        limit: LIVE_POLL_LIMIT,
      })
    );
    if (error) {
      setError(error);
      return false;
    }
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
  const update = useCallback(
    async (stepsOnly: boolean = false): Promise<{ foundNewItems: boolean }> => {
      if (isFetchingRef.current || !initialLoadCompleted) {
        return { foundNewItems: false };
      }

      let foundNewItems = false;

      try {
        const [_, stepsUpdated, hooksUpdated, eventsUpdated] =
          await Promise.all([
            stepsOnly ? Promise.resolve(false) : pollRun(),
            pollSteps(),
            stepsOnly ? Promise.resolve(false) : pollHooks(),
            stepsOnly ? Promise.resolve(false) : pollEvents(),
          ]);
        foundNewItems = stepsUpdated || hooksUpdated || eventsUpdated;
      } catch (err) {
        console.error('Update error:', err);
      }

      return { foundNewItems };
    },
    [pollSteps, pollHooks, pollEvents, initialLoadCompleted, pollRun]
  );

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
    const stepInterval = setInterval(() => {
      update(true);
    }, LIVE_STEP_UPDATE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      clearInterval(stepInterval);
    };
  }, [live, initialLoadCompleted, update, run?.completedAt]);

  return {
    run: run ?? ({} as WorkflowRun),
    steps,
    hooks,
    events,
    loading,
    auxiliaryDataLoading,
    error,
    update,
  };
}

// Helper function to fetch resource and get correlation ID
async function fetchResourceWithCorrelationId(
  env: EnvMap,
  resource: 'run' | 'step' | 'hook',
  resourceId: string,
  options: { runId?: string; resolveData?: 'none' | 'all' } = {}
): Promise<{
  data: WorkflowRun | Step | Hook;
  correlationId: string;
}> {
  let resourceData: WorkflowRun | Step | Hook;
  let correlationId: string;
  const resolveData = options.resolveData ?? 'all';

  if (resource === 'run') {
    const { error, result } = await unwrapServerActionResult(
      fetchRun(env, resourceId, resolveData)
    );
    if (error) {
      throw error;
    }
    resourceData = result;
    correlationId = (resourceData as WorkflowRun).runId;
  } else if (resource === 'step') {
    const { runId } = options;
    if (!runId) {
      throw new WorkflowWebAPIError('runId is required for step resource', {
        layer: 'client',
      });
    }
    const { error, result } = await unwrapServerActionResult(
      fetchStep(env, runId, resourceId, resolveData)
    );
    if (error) {
      throw error;
    }
    resourceData = result;
    correlationId = (resourceData as Step).stepId;
  } else if (resource === 'hook') {
    const { error, result } = await unwrapServerActionResult(
      fetchHook(env, resourceId, resolveData)
    );
    if (error) {
      throw error;
    }
    resourceData = result;
    correlationId = (resourceData as Hook).hookId;
  } else {
    throw new WorkflowWebAPIError(`Unknown resource type: ${resource}`, {
      layer: 'client',
    });
  }

  return { data: resourceData, correlationId };
}

/**
 * Returns (and keeps up-to-date) data inherent to a specific run/step/hook,
 * resolving input/output/metadata, AND loading all related events with full event data.
 */
export function useWorkflowResourceData(
  env: EnvMap,
  resource: 'run' | 'step' | 'hook' | 'sleep',
  resourceId: string,
  options: { refreshInterval?: number; runId?: string } = {}
) {
  const { refreshInterval = 0, runId } = options;

  const [data, setData] = useState<WorkflowRun | Step | Hook | Event | null>(
    null
  );
  // const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setData(null);
    setError(null);
    if (resource === 'sleep') {
      const { error, result } = await unwrapServerActionResult(
        fetchEventsByCorrelationId(env, resourceId, {
          sortOrder: 'asc',
          limit: 100,
          withData: true,
        })
      );
      if (error) {
        setError(error);
        return;
      }
      const eventsData = result;
      const waitStartEvent = eventsData.data.find(
        (event) => event.eventType === 'wait_created'
      );
      if (waitStartEvent) {
        setData({
          waitId: waitStartEvent.correlationId,
          runId: waitStartEvent.runId,
          createdAt: waitStartEvent.createdAt,
          resumeAt: waitStartEvent.eventData.resumeAt,
        } as unknown as Event);
      }
      return;
    }
    // Fetch resource with full data
    try {
      const { data: resourceData } = await fetchResourceWithCorrelationId(
        env,
        resource,
        resourceId,
        {
          runId,
        }
      );
      setData(resourceData);
    } catch (error: unknown) {
      if (error instanceof Error) {
        setError(error);
      } else {
        setError(new Error(String(error)));
      }
      return;
    } finally {
      setLoading(false);
    }

    // // Fetch events by correlation ID
    // const eventsData = await fetchAllEventsByCorrelationId(
    //   env,
    //   correlationId
    // );
    // setEvents(eventsData);
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
    // events,
    loading,
    error,
    refresh: fetchData,
  };
}

/**
 * Cancel a workflow run
 */
export async function cancelRun(env: EnvMap, runId: string): Promise<void> {
  const { error } = await unwrapServerActionResult(
    cancelRunServerAction(env, runId)
  );
  if (error) {
    throw error;
  }
}

/**
 * Start a new workflow run
 */
export async function recreateRun(env: EnvMap, runId: string): Promise<string> {
  const { error, result: resultData } = await unwrapServerActionResult(
    recreateRunServerAction(env, runId)
  );
  if (error) {
    throw error;
  }
  return resultData;
}

/**
 * Wake up a workflow run by re-enqueuing it
 */
export async function reenqueueRun(env: EnvMap, runId: string): Promise<void> {
  const { error } = await unwrapServerActionResult(
    reenqueueRunServerAction(env, runId)
  );
  if (error) {
    throw error;
  }
}

/**
 * Wake up a workflow run by interrupting any pending sleep() calls
 */
export async function wakeUpRun(
  env: EnvMap,
  runId: string,
  options?: StopSleepOptions
): Promise<StopSleepResult> {
  const { error, result: resultData } = await unwrapServerActionResult(
    wakeUpRunServerAction(env, runId, options)
  );
  if (error) {
    throw error;
  }
  return resultData;
}

function isServerActionError(value: unknown): value is ServerActionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    'layer' in value &&
    'cause' in value &&
    'request' in value
  );
}

export async function readStream(
  env: EnvMap,
  streamId: string,
  startIndex?: number
): Promise<ReadableStream<unknown>> {
  try {
    const stream = await readStreamServerAction(env, streamId, startIndex);
    if (!stream) {
      throw new WorkflowWebAPIError('Failed to read stream', {
        layer: 'client',
      });
    }
    if (isServerActionError(stream)) {
      throw new WorkflowWebAPIError(stream.message, {
        layer: 'client',
        cause: stream.cause,
        request: stream.request,
      });
    }
    return stream;
  } catch (error) {
    if (error instanceof WorkflowWebAPIError) {
      throw error;
    }
    throw new WorkflowWebAPIError('Failed to read stream', {
      layer: 'client',
      cause: error,
    });
  }
}

/**
 * List all stream IDs for a run
 */
export async function listStreams(
  env: EnvMap,
  runId: string
): Promise<string[]> {
  const { error, result } = await unwrapServerActionResult(
    fetchStreams(env, runId)
  );
  if (error) {
    throw error;
  }
  return result;
}

const STREAMS_REFRESH_INTERVAL_MS = 10000;

/**
 * Hook to fetch and manage stream list for a run
 */
export function useWorkflowStreams(
  env: EnvMap,
  runId: string,
  refreshInterval: number = STREAMS_REFRESH_INTERVAL_MS
) {
  const [streams, setStreams] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listStreams(env, runId);
      setStreams(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [env, runId]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh interval
  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0) {
      return;
    }

    const interval = setInterval(fetchData, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval, fetchData]);

  return {
    streams,
    loading,
    error,
    refresh: fetchData,
  };
}
