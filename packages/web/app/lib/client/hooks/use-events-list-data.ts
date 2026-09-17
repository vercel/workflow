'use client';

import type {
  ExactIdSearchResult,
  ExactWorkflowSearchIdKind,
} from '@workflow/web-shared';
import { hydrateResourceIOAsync } from '@workflow/web-shared';
import type { Event } from '@workflow/world';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unwrapServerActionResult } from '~/lib/client/workflow-errors';
import {
  fetchEvent,
  fetchEvents,
  fetchEventsByCorrelationId,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

const INITIAL_PAGE_SIZE = 100;
const LOAD_MORE_PAGE_SIZE = 100;
const MAX_WARM_REFRESH_PAGES = 5;
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
  const fetchingQueryRef = useRef<string | null>(null);
  const dataQueryRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const activePaginationRequestRef = useRef<number | null>(null);
  const paginationRequestIdRef = useRef(0);
  const loadedPageCountRef = useRef(1);

  const queryKey = useMemo(
    () =>
      JSON.stringify([
        Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
        runId,
        sortOrder,
      ]),
    [env, runId, sortOrder]
  );
  const committedQueryRef = useRef(queryKey);
  const queryGenerationRef = useRef({ key: queryKey, value: 0 });
  const previousEnabledRef = useRef(false);

  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;

  const hydrateEvents = useCallback(async (rawEvents: Event[]) => {
    let key: Uint8Array | undefined;
    let hydrated: Event[];
    do {
      key = encryptionKeyRef.current;
      hydrated = await Promise.all(
        rawEvents.map((event) => hydrateResourceIOAsync(event, key))
      );
    } while (encryptionKeyRef.current !== key);
    return hydrated;
  }, []);

  const fetchInitial = useCallback(async () => {
    if (fetchingQueryRef.current === queryKey) return;
    fetchingQueryRef.current = queryKey;
    const requestId = ++requestIdRef.current;
    const isColdQuery = dataQueryRef.current !== queryKey;

    if (isColdQuery) {
      dataQueryRef.current = null;
      loadedPageCountRef.current = 1;
      setLoading(true);
      setEvents([]);
      setCursor(undefined);
      setHasMore(false);
    }
    setLoadingMore(false);
    setError(null);

    try {
      const targetPageCount = isColdQuery
        ? 1
        : Math.min(loadedPageCountRef.current, MAX_WARM_REFRESH_PAGES);
      const rawEvents: Event[] = [];
      let nextCursor: string | undefined;
      let nextHasMore = false;
      let pagesFetched = 0;

      while (pagesFetched < targetPageCount) {
        const { error: fetchError, result } = await unwrapServerActionResult(
          fetchEvents(env, runId, {
            cursor: nextCursor,
            sortOrder,
            limit: INITIAL_PAGE_SIZE,
            withData: false,
          })
        );
        if (requestIdRef.current !== requestId) return;
        if (fetchError) {
          setError(fetchError);
          return;
        }

        rawEvents.push(...result.data);
        pagesFetched += 1;
        nextHasMore = Boolean(result.hasMore);
        nextCursor = nextHasMore ? result.cursor : undefined;
        if (!nextHasMore || !nextCursor) break;
      }

      const refreshedEvents = await hydrateEvents(rawEvents);
      if (requestIdRef.current !== requestId) return;
      setEvents(refreshedEvents);
      setCursor(nextCursor);
      setHasMore(nextHasMore);
      loadedPageCountRef.current = Math.max(1, pagesFetched);
      dataQueryRef.current = queryKey;
    } catch (err) {
      if (requestIdRef.current === requestId) setError(err as Error);
    } finally {
      if (
        fetchingQueryRef.current === queryKey &&
        requestIdRef.current === requestId
      ) {
        fetchingQueryRef.current = null;
      }
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [env, runId, sortOrder, hydrateEvents, queryKey]);

  useEffect(() => {
    const queryChanged = committedQueryRef.current !== queryKey;
    const wasEnabled = previousEnabledRef.current;
    const becameEnabled = enabled && !wasEnabled;
    previousEnabledRef.current = enabled;

    if (queryChanged) {
      committedQueryRef.current = queryKey;
      queryGenerationRef.current = {
        key: queryKey,
        value: queryGenerationRef.current.value + 1,
      };
      activePaginationRequestRef.current = null;
      fetchingQueryRef.current = null;
      requestIdRef.current += 1;
    }

    if (!enabled) {
      if (wasEnabled) {
        activePaginationRequestRef.current = null;
        fetchingQueryRef.current = null;
        requestIdRef.current += 1;
      }
      return;
    }

    if (
      (!queryChanged && fetchingQueryRef.current === queryKey) ||
      (!queryChanged && !becameEnabled && dataQueryRef.current === queryKey)
    ) {
      return;
    }

    if (!queryChanged) {
      queryGenerationRef.current = {
        key: queryKey,
        value: queryGenerationRef.current.value + 1,
      };
      activePaginationRequestRef.current = null;
    }
    fetchInitial();
  }, [fetchInitial, enabled, queryKey]);

  useEffect(
    () => () => {
      activePaginationRequestRef.current = null;
      fetchingQueryRef.current = null;
      requestIdRef.current += 1;
    },
    []
  );

  // Re-hydrate loaded events with decryption when encryption key becomes available
  useEffect(() => {
    if (!encryptionKey || events.length === 0) return;
    let cancelled = false;
    const queryGeneration = queryGenerationRef.current.value;
    Promise.all(events.map((ev) => hydrateResourceIOAsync(ev, encryptionKey)))
      .then((decrypted) => {
        if (
          !cancelled &&
          queryGenerationRef.current.value === queryGeneration
        ) {
          const decryptedById = new Map(
            decrypted.map((event) => [event.eventId, event])
          );
          setEvents((current) =>
            current.map((event) => decryptedById.get(event.eventId) ?? event)
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey]);

  const loadMore = useCallback(async () => {
    if (
      activePaginationRequestRef.current !== null ||
      fetchingQueryRef.current !== null ||
      !cursor ||
      dataQueryRef.current !== queryKey
    ) {
      return;
    }
    const requestQuery = queryKey;
    const queryGeneration = queryGenerationRef.current.value;
    const paginationRequestId = ++paginationRequestIdRef.current;
    activePaginationRequestRef.current = paginationRequestId;
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
      if (
        committedQueryRef.current !== requestQuery ||
        queryGenerationRef.current.value !== queryGeneration
      ) {
        return;
      }
      if (fetchError) {
        setError(fetchError);
      } else {
        loadedPageCountRef.current += 1;
        if (result.data.length > 0) {
          const hydrated = await hydrateEvents(result.data);
          if (
            committedQueryRef.current !== requestQuery ||
            queryGenerationRef.current.value !== queryGeneration
          ) {
            return;
          }
          setEvents((prev) => [...prev, ...hydrated]);
        }
        setCursor(result.hasMore ? result.cursor : undefined);
        setHasMore(Boolean(result.hasMore));
      }
    } catch (err) {
      if (
        committedQueryRef.current === requestQuery &&
        queryGenerationRef.current.value === queryGeneration
      ) {
        setError(err as Error);
      }
    } finally {
      if (activePaginationRequestRef.current === paginationRequestId) {
        activePaginationRequestRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [env, runId, sortOrder, cursor, hydrateEvents, queryKey]);

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
    loadingMore,
    loadMore,
    searchByExactId,
  };
}
