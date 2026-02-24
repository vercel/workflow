import { hydrateResourceIO } from '@workflow/web-shared';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchEvents,
  fetchHooks,
  fetchRun,
  fetchSteps,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';
import { unwrapServerActionResult } from '~/lib/client/workflow-errors';
import {
  fetchAllPaginated,
  pollResource,
} from '~/lib/client/workflow-primitives';

const LIVE_POLL_LIMIT = 10;
const LIVE_STEP_UPDATE_INTERVAL_MS = 2000;
const LIVE_UPDATE_INTERVAL_MS = 5000;

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
          setRun(hydrateResourceIO(result));
          return result;
        }
      ),
      fetchAllPaginated<Step>((cursor) =>
        unwrapServerActionResult(
          fetchSteps(env, runId, { cursor, sortOrder: 'asc', limit: 100 })
        )
      ).then((result) => {
        setSteps(result.data.map(hydrateResourceIO));
        setStepsCursor(result.cursor);
      }),
      fetchAllPaginated<Hook>((cursor) =>
        unwrapServerActionResult(
          fetchHooks(env, {
            runId,
            cursor,
            sortOrder: 'asc',
            limit: 100,
          })
        )
      ).then((result) => {
        setHooks(result.data.map(hydrateResourceIO));
        setHooksCursor(result.cursor);
      }),
      fetchAllPaginated<Event>((cursor) =>
        unwrapServerActionResult(
          fetchEvents(env, runId, { cursor, sortOrder: 'asc', limit: 1000 })
        )
      ).then((result) => {
        setEvents(result.data.map(hydrateResourceIO));
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
  };
}
