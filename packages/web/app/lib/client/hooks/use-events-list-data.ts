'use client';

import type { Event } from '@workflow/world';
import type { ExactWorkflowSearchIdKind } from '@workflow/web-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hydrateResourceIO,
  hydrateResourceIOWithKey,
} from '@workflow/web-shared';
import { unwrapServerActionResult } from '~/lib/client/workflow-errors';
import {
  fetchEvent,
  fetchEvents,
  fetchEventsByCorrelationId,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

const INITIAL_PAGE_SIZE = 100;
const LOAD_MORE_PAGE_SIZE = 100;
/** Max pages when fetching correlation ID search results (100 events/page). */
const MAX_CORRELATION_SEARCH_PAGES = 30;

/**
 * Independent event fetching for the Events tab.
 * Separate from the trace viewer's events so sort order changes
 * don't affect the trace viewer.
 */
export function useEventsListData(
  env: EnvMap,
  runId: string,
  options: {
    sortOrder?: 'asc' | 'desc';
    encryptionKey?: Uint8Array;
    /** When false, defers fetching until enabled. Defaults to true. */
    enabled?: boolean;
  } = {}
) {
  const { sortOrder = 'asc', encryptionKey, enabled = true } = options;

  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const isFetchingRef = useRef(false);

  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;

  const hydrateEvents = useCallback(async (rawEvents: Event[]) => {
    const hydrated = rawEvents.map(hydrateResourceIO);
    const key = encryptionKeyRef.current;
    if (key) {
      return Promise.all(
        hydrated.map((ev) => hydrateResourceIOWithKey(ev, key))
      );
    }
    return hydrated;
  }, []);

  const fetchInitial = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setLoading(true);
    setError(null);
    setEvents([]);
    setCursor(undefined);
    setHasMore(false);

    try {
      const { error: fetchError, result } = await unwrapServerActionResult(
        fetchEvents(env, runId, {
          sortOrder,
          limit: INITIAL_PAGE_SIZE,
          withData: false,
        })
      );
      if (fetchError) {
        setError(fetchError);
      } else {
        setEvents(await hydrateEvents(result.data));
        setCursor(result.hasMore ? result.cursor : undefined);
        setHasMore(Boolean(result.hasMore));
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [env, runId, sortOrder, hydrateEvents]);

  useEffect(() => {
    if (enabled) fetchInitial();
  }, [fetchInitial, enabled]);

  // Re-hydrate loaded events with decryption when encryption key becomes available
  useEffect(() => {
    if (!encryptionKey || events.length === 0) return;
    let cancelled = false;
    Promise.all(events.map((ev) => hydrateResourceIOWithKey(ev, encryptionKey)))
      .then((decrypted) => {
        if (!cancelled) setEvents(decrypted);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const { error: fetchError, result } = await unwrapServerActionResult(
        fetchEvents(env, runId, {
          cursor,
          sortOrder,
          limit: LOAD_MORE_PAGE_SIZE,
          withData: false,
        })
      );
      if (fetchError) {
        setError(fetchError);
      } else {
        if (result.data.length > 0) {
          const hydrated = await hydrateEvents(result.data);
          setEvents((prev) => [...prev, ...hydrated]);
        }
        setCursor(result.hasMore ? result.cursor : undefined);
        setHasMore(Boolean(result.hasMore));
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoadingMore(false);
    }
  }, [env, runId, sortOrder, cursor, loadingMore, hydrateEvents]);

  const searchByExactId = useCallback(
    async (
      id: string,
      kind: ExactWorkflowSearchIdKind,
      _signal?: AbortSignal
    ): Promise<Event[] | null> => {
      if (kind === 'event') {
        const { error: fetchError, result } = await unwrapServerActionResult(
          fetchEvent(env, runId, id, 'none')
        );
        if (fetchError) {
          return null;
        }
        const [event] = await hydrateEvents([result]);
        return event?.runId === runId ? [event] : null;
      }

      const matched: Event[] = [];
      let nextCursor: string | undefined;
      let pagesFetched = 0;
      do {
        const { error: fetchError, result } = await unwrapServerActionResult(
          fetchEventsByCorrelationId(env, id, {
            cursor: nextCursor,
            sortOrder,
            limit: 100,
            withData: false,
          })
        );
        if (fetchError) {
          return null;
        }

        pagesFetched += 1;
        const hydrated = await hydrateEvents(result.data);
        matched.push(...hydrated.filter((event) => event.runId === runId));

        nextCursor =
          pagesFetched < MAX_CORRELATION_SEARCH_PAGES &&
          result.hasMore &&
          result.cursor
            ? result.cursor
            : undefined;
      } while (nextCursor);

      return matched.length > 0 ? matched : null;
    },
    [env, runId, sortOrder, hydrateEvents]
  );

  return {
    events,
    loading,
    error,
    hasMore,
    loadingMore,
    loadMore,
    searchByExactId,
  };
}
