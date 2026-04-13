import { hasEncryptedFields, hydrateResourceIO } from '@workflow/web-shared';
import type { Event, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrapServerActionResult } from '~/lib/client/workflow-errors';
import { mergeById, pollResource } from '~/lib/client/workflow-primitives';
import { fetchEvents, fetchRun } from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

const LIVE_POLL_LIMIT = 100;
const INITIAL_PAGE_SIZE = 500;
const LOAD_MORE_PAGE_SIZE = 100;
const LIVE_UPDATE_INTERVAL_MS = 5000;

/**
 * Returns (and keeps up-to-date) the Run and Events for a workflow run.
 * The trace viewer builds spans entirely from events — Steps and Hooks
 * are fetched on-demand by the detail sidebar, not here.
 */
export function useWorkflowTraceViewerData(
  env: EnvMap,
  runId: string,
  options: { live?: boolean } = {}
) {
  const { live = false } = options;

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const [eventsCursor, setEventsCursor] = useState<string | undefined>();
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [isLoadingMoreTraceData, setIsLoadingMoreTraceData] = useState(false);
  const [hasEncryptedData, setHasEncryptedData] = useState(false);

  const isFetchingRef = useRef(false);
  const mountedRef = useRef(true);
  const [initialLoadCompleted, setInitialLoadCompleted] = useState(false);

  // Fetch Run + first page of Events. These are the only two resources
  // needed to render the trace viewer.
  const fetchAllData = useCallback(async () => {
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    setLoading(true);
    setError(null);

    const [runResult, eventsResult] = await Promise.all([
      unwrapServerActionResult(fetchRun(env, runId, 'none')),
      unwrapServerActionResult(
        fetchEvents(env, runId, {
          sortOrder: 'asc',
          limit: INITIAL_PAGE_SIZE,
          withData: false,
        })
      ),
    ]);

    if (runResult.error) {
      setError(runResult.error);
    } else {
      setRun(hydrateResourceIO(runResult.result));
    }

    const initialEvents = eventsResult.error
      ? []
      : eventsResult.result.data.map(hydrateResourceIO);

    setEvents(mergeById<Event>([], initialEvents, 'eventId'));
    setEventsCursor(
      eventsResult.error || !eventsResult.result.hasMore
        ? undefined
        : eventsResult.result.cursor
    );
    setEventsHasMore(
      Boolean(!eventsResult.error && eventsResult.result.hasMore)
    );

    setLoading(false);
    setInitialLoadCompleted(true);
    isFetchingRef.current = false;

    if (!runResult.error && eventsResult.error) {
      setError(eventsResult.error);
    }

    // Detect encryption: newer runs store a flag in executionContext.
    // For older runs that lack the flag, fall back to a probe fetch.
    if (!runResult.error) {
      const ctx = runResult.result.executionContext as
        | Record<string, unknown>
        | undefined;
      if (
        ctx?.features &&
        (ctx.features as Record<string, unknown>).encryption
      ) {
        setHasEncryptedData(true);
      } else {
        unwrapServerActionResult(
          fetchEvents(env, runId, {
            sortOrder: 'asc',
            limit: 1,
            withData: true,
          })
        )
          .then((probeResult) => {
            if (
              mountedRef.current &&
              !probeResult.error &&
              probeResult.result.data.some((e) =>
                hasEncryptedFields(hydrateResourceIO(e))
              )
            ) {
              setHasEncryptedData(true);
            }
          })
          .catch(() => {});
      }
    }
  }, [env, runId]);

  const loadMoreTraceData = useCallback(async () => {
    if (
      isFetchingRef.current ||
      !initialLoadCompleted ||
      isLoadingMoreTraceData ||
      !eventsHasMore
    ) {
      return;
    }

    setIsLoadingMoreTraceData(true);
    try {
      const nextEventsResult = await unwrapServerActionResult(
        fetchEvents(env, runId, {
          cursor: eventsCursor,
          sortOrder: 'asc',
          limit: LOAD_MORE_PAGE_SIZE,
          withData: false,
        })
      );

      if (nextEventsResult.error) {
        setError(nextEventsResult.error);
      } else {
        const nextEvents = nextEventsResult.result.data.map(hydrateResourceIO);

        if (nextEvents.length > 0) {
          setEvents((prev) => mergeById(prev, nextEvents, 'eventId'));
        }

        setEventsHasMore(Boolean(nextEventsResult.result.hasMore));
        setEventsCursor(
          nextEventsResult.result.hasMore
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
    eventsHasMore,
    eventsCursor,
  ]);

  const pollRun = useCallback(async (): Promise<boolean> => {
    if (run?.completedAt) {
      return false;
    }
    const { error, result } = await unwrapServerActionResult(
      fetchRun(env, runId, 'none')
    );
    if (error) {
      setError(error);
      return false;
    }
    setError(null);
    setRun(hydrateResourceIO(result));
    return true;
  }, [env, runId, run?.completedAt]);

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
              withData: false,
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
  const update = useCallback(async (): Promise<{ foundNewItems: boolean }> => {
    if (isFetchingRef.current || !initialLoadCompleted) {
      return { foundNewItems: false };
    }

    let foundNewItems = false;

    try {
      const [_, eventsUpdated] = await Promise.all([pollRun(), pollEvents()]);
      foundNewItems = eventsUpdated;
    } catch (err) {
      console.error('Update error:', err);
    }

    return { foundNewItems };
  }, [pollEvents, initialLoadCompleted, pollRun]);

  // Initial load
  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  // Cleanup: mark unmounted so fire-and-forget probes don't update state.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Live polling
  useEffect(() => {
    if (!live || !initialLoadCompleted || run?.completedAt) {
      return;
    }

    const interval = setInterval(() => {
      update();
    }, LIVE_UPDATE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [live, initialLoadCompleted, update, run?.completedAt]);

  return {
    run: run ?? ({} as WorkflowRun),
    events,
    loading,
    error,
    update,
    loadMoreTraceData,
    hasMoreTraceData: eventsHasMore,
    isLoadingMoreTraceData,
    hasEncryptedData,
  };
}
