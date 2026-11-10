'use client';

import type {
  ExactIdSearchResult,
  ExactWorkflowSearchIdKind,
} from '@workflow/web-shared';
import { hydrateResourceIOAsync } from '@workflow/web-shared';
import type { Event } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrapServerActionResult } from '~/lib/client/workflow-errors';
import {
  fetchEvent,
  fetchEvents,
  fetchEventsByCorrelationId,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

const INITIAL_PAGE_SIZE = 100;
const LOAD_MORE_PAGE_SIZE = 100;
/**
 * Max pages when fetching correlation ID search results (100 events/page).
 *
 * Kept low for the storage read path, which filters server-side and so can
 * cost considerably more to produce a page than the page returns. The
 * previous 30 was sized for the analytics path, where the same scan was
 * much cheaper.
 */
const MAX_CORRELATION_SEARCH_PAGES = 5;

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
  const [refreshing, setRefreshing] = useState(false);
  // Bumped per query fetch so responses from a superseded query are dropped.
  const generationRef = useRef(0);
  const pagesLoadedRef = useRef(0);
  const loadedQueryRef = useRef<unknown>(null);

  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;

  const hydrateEvents = useCallback(async (rawEvents: Event[]) => {
    const key = encryptionKeyRef.current;
    return Promise.all(rawEvents.map((ev) => hydrateResourceIOAsync(ev, key)));
  }, []);

  /**
   * Fetches `pageCount` pages from the start. A cold fetch clears the list
   * and shows the loading state; a warm one (tab re-entry for the same query)
   * keeps the current rows on screen and swaps them in when done.
   */
  const fetchPages = useCallback(
    async (pageCount: number, cold: boolean) => {
      const generation = ++generationRef.current;
      const isCurrent = () => generation === generationRef.current;
      setRefreshing(true);
      if (cold) {
        setLoading(true);
        setError(null);
        setEvents([]);
        setCursor(undefined);
        setHasMore(false);
      }

      try {
        const collected: Event[] = [];
        let nextCursor: string | undefined;
        let more = false;
        let pages = 0;
        do {
          const { error: fetchError, result } = await unwrapServerActionResult(
            fetchEvents(env, runId, {
              cursor: nextCursor,
              sortOrder,
              limit: pages === 0 ? INITIAL_PAGE_SIZE : LOAD_MORE_PAGE_SIZE,
              withData: false,
            })
          );
          if (!isCurrent()) return;
          if (fetchError) {
            // A failed background refresh keeps the rows already shown.
            if (cold) setError(fetchError);
            return;
          }
          collected.push(...(await hydrateEvents(result.data)));
          if (!isCurrent()) return;
          pages += 1;
          more = Boolean(result.hasMore);
          nextCursor = more ? result.cursor : undefined;
        } while (pages < pageCount && nextCursor);

        pagesLoadedRef.current = pages;
        setError(null);
        setEvents(collected);
        setCursor(nextCursor);
        setHasMore(more);
      } catch (err) {
        if (isCurrent() && cold) setError(err as Error);
      } finally {
        if (isCurrent()) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [env, runId, sortOrder, hydrateEvents]
  );

  // fetchPages' identity is the query (env, run, sort). Re-enabling the same
  // query revalidates in place; a new query starts cold.
  useEffect(() => {
    if (!enabled) return;
    const warm = loadedQueryRef.current === fetchPages;
    loadedQueryRef.current = fetchPages;
    fetchPages(warm ? Math.max(1, pagesLoadedRef.current) : 1, !warm);
  }, [fetchPages, enabled]);

  // Re-hydrate loaded events with decryption when encryption key becomes available
  useEffect(() => {
    if (!encryptionKey || events.length === 0) return;
    let cancelled = false;
    Promise.all(events.map((ev) => hydrateResourceIOAsync(ev, encryptionKey)))
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
    if (refreshing || loadingMore || !cursor) return;
    const generation = generationRef.current;
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
      if (generation !== generationRef.current) return;
      if (fetchError) {
        setError(fetchError);
      } else {
        const hydrated = await hydrateEvents(result.data);
        if (generation !== generationRef.current) return;
        if (hydrated.length > 0) setEvents((prev) => [...prev, ...hydrated]);
        pagesLoadedRef.current += 1;
        setCursor(result.hasMore ? result.cursor : undefined);
        setHasMore(Boolean(result.hasMore));
      }
    } catch (err) {
      if (generation === generationRef.current) setError(err as Error);
    } finally {
      setLoadingMore(false);
    }
  }, [env, runId, sortOrder, cursor, loadingMore, refreshing, hydrateEvents]);

  const searchByExactId = useCallback(
    async (
      id: string,
      kind: ExactWorkflowSearchIdKind,
      signal?: AbortSignal
    ): Promise<ExactIdSearchResult> => {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (kind === 'event') {
        const { error: fetchError, result } = await unwrapServerActionResult(
          fetchEvent(env, runId, id, 'none')
        );
        if (fetchError || signal?.aborted) {
          return fetchError
            ? { status: 'error', message: fetchError.message }
            : (() => {
                throw new DOMException('Aborted', 'AbortError');
              })();
        }
        const [event] = await hydrateEvents([result]);
        return event?.runId === runId
          ? { status: 'ok', events: [event] }
          : { status: 'not_found' };
      }

      const matched: Event[] = [];
      let nextCursor: string | undefined;
      let pagesFetched = 0;
      let truncated = false;
      do {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const { error: fetchError, result } = await unwrapServerActionResult(
          fetchEventsByCorrelationId(env, id, {
            cursor: nextCursor,
            sortOrder,
            limit: 100,
            withData: false,
            runId,
          })
        );
        if (fetchError) {
          return { status: 'error', message: fetchError.message };
        }
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        pagesFetched += 1;
        const hydrated = await hydrateEvents(result.data);
        matched.push(...hydrated.filter((event) => event.runId === runId));

        const hitPageCap = pagesFetched >= MAX_CORRELATION_SEARCH_PAGES;
        truncated =
          truncated || (hitPageCap && Boolean(result.hasMore && result.cursor));
        nextCursor =
          !hitPageCap && result.hasMore && result.cursor
            ? result.cursor
            : undefined;
      } while (nextCursor);

      return matched.length > 0
        ? { status: 'ok', events: matched, truncated: truncated || undefined }
        : { status: 'not_found' };
    },
    [env, runId, sortOrder, hydrateEvents]
  );

  return {
    events,
    loading,
    error,
    hasMore,
    loadingMore: loadingMore || refreshing,
    loadMore,
    searchByExactId,
  };
}
