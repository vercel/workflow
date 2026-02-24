import { hydrateResourceIO } from '@workflow/web-shared';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchEvents,
  fetchEventsByCorrelationId,
  fetchHooks,
  fetchRun,
  fetchSteps,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';
import { unwrapServerActionResult } from '~/lib/client/workflow-errors';
import {
  MAX_ITEMS,
  mergeById,
  pollResource,
} from '~/lib/client/workflow-primitives';

const LIVE_POLL_LIMIT = 10;
const TRACE_VIEWER_BATCH_SIZE = 50;
const LIVE_STEP_UPDATE_INTERVAL_MS = 2000;
const LIVE_UPDATE_INTERVAL_MS = 5000;

async function fetchAllEventsForCorrelationId(
  env: EnvMap,
  correlationId: string
): Promise<Event[]> {
  let eventsData: Event[] = [];
  let cursor: string | undefined;

  while (true) {
    const { error, result } = await unwrapServerActionResult(
      fetchEventsByCorrelationId(env, correlationId, {
        cursor,
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
    cursor = result.cursor;
  }

  return eventsData;
}

async function fetchEventsForCorrelationIds(
  env: EnvMap,
  correlationIds: string[]
): Promise<Event[]> {
  if (correlationIds.length === 0) {
    return [];
  }
  const results = await Promise.all(
    correlationIds.map((correlationId) =>
      fetchAllEventsForCorrelationId(env, correlationId)
    )
  );
  return results.flat();
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
  const [stepsHasMore, setStepsHasMore] = useState(false);
  const [hooksHasMore, setHooksHasMore] = useState(false);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [isLoadingMoreTraceData, setIsLoadingMoreTraceData] = useState(false);

  const isFetchingRef = useRef(false);
  const [initialLoadCompleted, setInitialLoadCompleted] = useState(false);

  // Fetch first trace page and related events for visible spans.
  const fetchAllData = useCallback(async () => {
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    setLoading(true);
    setAuxiliaryDataLoading(true);
    setError(null);

    const [runResult, stepsResult, hooksResult, eventsResult] =
      await Promise.all([
        unwrapServerActionResult(fetchRun(env, runId)),
        unwrapServerActionResult(
          fetchSteps(env, runId, {
            sortOrder: 'asc',
            limit: TRACE_VIEWER_BATCH_SIZE,
          })
        ),
        unwrapServerActionResult(
          fetchHooks(env, {
            runId,
            sortOrder: 'asc',
            limit: TRACE_VIEWER_BATCH_SIZE,
          })
        ),
        unwrapServerActionResult(
          fetchEvents(env, runId, {
            sortOrder: 'asc',
            limit: TRACE_VIEWER_BATCH_SIZE,
          })
        ),
      ]);

    if (runResult.error) {
      setError(runResult.error);
    } else {
      setRun(hydrateResourceIO(runResult.result));
    }

    const nextSteps = stepsResult.error
      ? []
      : stepsResult.result.data.map(hydrateResourceIO);
    const nextHooks = hooksResult.error
      ? []
      : hooksResult.result.data.map(hydrateResourceIO);
    const initialEvents = eventsResult.error
      ? []
      : eventsResult.result.data.map(hydrateResourceIO);

    const correlationIds = [
      ...nextSteps.map((step) => step.stepId),
      ...nextHooks.map((hook) => hook.hookId),
    ];
    const correlationEventsRaw = await fetchEventsForCorrelationIds(
      env,
      correlationIds
    );
    const correlationEvents = correlationEventsRaw.map(hydrateResourceIO);

    setSteps(nextSteps);
    setHooks(nextHooks);
    setEvents(
      mergeById<Event>([], [...initialEvents, ...correlationEvents], 'eventId')
    );

    setStepsCursor(
      stepsResult.error || !stepsResult.result.hasMore
        ? undefined
        : stepsResult.result.cursor
    );
    setHooksCursor(
      hooksResult.error || !hooksResult.result.hasMore
        ? undefined
        : hooksResult.result.cursor
    );
    setEventsCursor(
      eventsResult.error || !eventsResult.result.hasMore
        ? undefined
        : eventsResult.result.cursor
    );
    setStepsHasMore(Boolean(!stepsResult.error && stepsResult.result.hasMore));
    setHooksHasMore(Boolean(!hooksResult.error && hooksResult.result.hasMore));
    setEventsHasMore(
      Boolean(!eventsResult.error && eventsResult.result.hasMore)
    );

    const settledResults = [runResult, stepsResult, hooksResult, eventsResult];
    setLoading(false);
    setAuxiliaryDataLoading(false);
    setInitialLoadCompleted(true);
    isFetchingRef.current = false;

    if (!runResult.error) {
      const firstError = settledResults.find((result) => result.error)?.error;
      if (firstError) {
        setError(firstError);
      }
    }
  }, [env, runId]);

  const loadMoreTraceData = useCallback(async () => {
    if (
      isFetchingRef.current ||
      !initialLoadCompleted ||
      isLoadingMoreTraceData
    ) {
      return;
    }
    if (!stepsHasMore && !hooksHasMore && !eventsHasMore) {
      return;
    }

    setIsLoadingMoreTraceData(true);
    try {
      const [nextStepsResult, nextHooksResult, nextEventsResult] =
        await Promise.all([
          stepsHasMore
            ? unwrapServerActionResult(
                fetchSteps(env, runId, {
                  cursor: stepsCursor,
                  sortOrder: 'asc',
                  limit: TRACE_VIEWER_BATCH_SIZE,
                })
              )
            : Promise.resolve({ error: null, result: null }),
          hooksHasMore
            ? unwrapServerActionResult(
                fetchHooks(env, {
                  runId,
                  cursor: hooksCursor,
                  sortOrder: 'asc',
                  limit: TRACE_VIEWER_BATCH_SIZE,
                })
              )
            : Promise.resolve({ error: null, result: null }),
          eventsHasMore
            ? unwrapServerActionResult(
                fetchEvents(env, runId, {
                  cursor: eventsCursor,
                  sortOrder: 'asc',
                  limit: TRACE_VIEWER_BATCH_SIZE,
                })
              )
            : Promise.resolve({ error: null, result: null }),
        ]);

      if (nextStepsResult.error) {
        setError(nextStepsResult.error);
      }
      if (nextHooksResult.error) {
        setError(nextHooksResult.error);
      }
      if (nextEventsResult.error) {
        setError(nextEventsResult.error);
      }

      const nextSteps =
        nextStepsResult.result?.data.map(hydrateResourceIO) ?? [];
      const nextHooks =
        nextHooksResult.result?.data.map(hydrateResourceIO) ?? [];
      const nextEvents =
        nextEventsResult.result?.data.map(hydrateResourceIO) ?? [];

      if (nextSteps.length > 0) {
        setSteps((prev) => mergeById(prev, nextSteps, 'stepId'));
      }
      if (nextHooks.length > 0) {
        setHooks((prev) => mergeById(prev, nextHooks, 'hookId'));
      }

      const newCorrelationIds = [
        ...nextSteps.map((step) => step.stepId),
        ...nextHooks.map((hook) => hook.hookId),
      ];
      const correlationEventsRaw = await fetchEventsForCorrelationIds(
        env,
        newCorrelationIds
      );
      const correlationEvents = correlationEventsRaw.map(hydrateResourceIO);
      const allNewEvents = [...nextEvents, ...correlationEvents];
      if (allNewEvents.length > 0) {
        setEvents((prev) => mergeById(prev, allNewEvents, 'eventId'));
      }

      const nextStepsHasMore = nextStepsResult.error
        ? stepsHasMore
        : Boolean(nextStepsResult.result && nextStepsResult.result.hasMore);
      const nextHooksHasMore = nextHooksResult.error
        ? hooksHasMore
        : Boolean(nextHooksResult.result && nextHooksResult.result.hasMore);
      const nextEventsHasMore = nextEventsResult.error
        ? eventsHasMore
        : Boolean(nextEventsResult.result && nextEventsResult.result.hasMore);

      setStepsHasMore(nextStepsHasMore);
      setHooksHasMore(nextHooksHasMore);
      setEventsHasMore(nextEventsHasMore);

      if (!nextStepsResult.error) {
        setStepsCursor(
          nextStepsResult.result?.hasMore
            ? nextStepsResult.result.cursor
            : undefined
        );
      }
      if (!nextHooksResult.error) {
        setHooksCursor(
          nextHooksResult.result?.hasMore
            ? nextHooksResult.result.cursor
            : undefined
        );
      }
      if (!nextEventsResult.error) {
        setEventsCursor(
          nextEventsResult.result?.hasMore
            ? nextEventsResult.result.cursor
            : undefined
        );
      }
    } finally {
      setIsLoadingMoreTraceData(false);
    }
  }, [
    env,
    runId,
    initialLoadCompleted,
    isLoadingMoreTraceData,
    stepsHasMore,
    hooksHasMore,
    eventsHasMore,
    stepsCursor,
    hooksCursor,
    eventsCursor,
  ]);

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
    setRun(hydrateResourceIO(result));
    return true;
  }, [env, runId, run?.completedAt]);

  // Poll for new steps
  // Uses 'onHasMore' cursor strategy: we intentionally leave the cursor where it is
  // unless we're at the end of the page, so that we re-fetch existing steps to ensure
  // their status gets updated.
  const pollSteps = useCallback(
    () =>
      pollResource<Step>({
        fetchFn: () =>
          unwrapServerActionResult(
            fetchSteps(env, runId, {
              cursor: stepsCursor,
              sortOrder: 'asc',
              limit: LIVE_POLL_LIMIT,
            })
          ),
        setItems: setSteps,
        setCursor: setStepsCursor,
        setError,
        idKey: 'stepId',
        cursorStrategy: 'onHasMore',
        transform: hydrateResourceIO,
      }),
    [env, runId, stepsCursor]
  );

  // Poll for new hooks
  const pollHooks = useCallback(
    () =>
      pollResource<Hook>({
        fetchFn: () =>
          unwrapServerActionResult(
            fetchHooks(env, {
              runId,
              cursor: hooksCursor,
              sortOrder: 'asc',
              limit: LIVE_POLL_LIMIT,
            })
          ),
        setItems: setHooks,
        setCursor: setHooksCursor,
        setError,
        idKey: 'hookId',
        transform: hydrateResourceIO,
      }),
    [env, runId, hooksCursor]
  );

  // Poll for new events
  const pollEvents = useCallback(
    () =>
      pollResource<Event>({
        fetchFn: () =>
          unwrapServerActionResult(
            fetchEvents(env, runId, {
              cursor: eventsCursor,
              sortOrder: 'asc',
              limit: LIVE_POLL_LIMIT,
            })
          ),
        setItems: setEvents,
        setCursor: setEventsCursor,
        setError,
        idKey: 'eventId',
        transform: hydrateResourceIO,
      }),
    [env, runId, eventsCursor]
  );

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
    loadMoreTraceData,
    hasMoreTraceData: stepsHasMore || hooksHasMore || eventsHasMore,
    isLoadingMoreTraceData,
  };
}
