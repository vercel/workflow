'use client';

import type {
  ExactIdSearchResult,
  ExactWorkflowSearchIdKind,
} from '@workflow/web-shared';
import { hydrateResourceIOAsync } from '@workflow/web-shared';
import type { Event } from '@workflow/world';
import { useCallback, useRef } from 'react';
import {
  unwrapOrThrow,
  unwrapServerActionResult,
} from '~/lib/client/workflow-errors';
import {
  fetchEvent,
  fetchEvents,
  fetchEventsByCorrelationId,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';
import { useInfiniteList } from './use-infinite-list';

const PAGE_SIZE = 100;
/**
 * Max pages when fetching correlation ID search results (100 events/page).
 *
 * Kept low for the storage read path, which filters server-side and so can
 * cost considerably more to produce a page than the page returns. The
 * previous 30 was sized for the analytics path, where the same scan was
 * much cheaper.
 */
const MAX_CORRELATION_SEARCH_PAGES = 5;

const getEventId = (event: Event) => event.eventId;

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
    /** Used when hydrating exact-ID search results. */
    encryptionKey?: Uint8Array;
  } = {}
) {
  const { sortOrder = 'asc', encryptionKey } = options;

  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;

  const hydrateEvents = useCallback(async (rawEvents: Event[]) => {
    const key = encryptionKeyRef.current;
    return Promise.all(rawEvents.map((ev) => hydrateResourceIOAsync(ev, key)));
  }, []);

  // Rows are listed without payloads (`withData: false`), so there is nothing
  // in them to hydrate or decrypt.
  const fetchPage = useCallback(
    (cursor?: string) =>
      unwrapOrThrow(
        fetchEvents(env, runId, {
          cursor,
          sortOrder,
          limit: PAGE_SIZE,
          withData: false,
        })
      ),
    [env, runId, sortOrder]
  );

  // Rows restored from the cache may be stale. A new query starts empty.
  const list = useInfiniteList(
    `run-events:${runId}:${sortOrder}`,
    fetchPage,
    getEventId,
    { keepPreviousData: false, revalidateCached: true }
  );

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
    events: list.items,
    loading: list.isLoading,
    error: list.error,
    hasMore: list.hasMore,
    loadingMore: list.isLoadingMore,
    loadMore: list.loadMore,
    searchByExactId,
  };
}
