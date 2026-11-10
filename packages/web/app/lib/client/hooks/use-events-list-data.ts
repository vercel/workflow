'use client';

import type {
  ExactIdSearchResult,
  ExactWorkflowSearchIdKind,
} from '@workflow/web-shared';
import { hydrateResourceIOAsync } from '@workflow/web-shared';
import type { Event } from '@workflow/world';
import { useCallback, useEffect, useRef } from 'react';
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
    encryptionKey?: Uint8Array;
    /** When false, defers fetching until enabled. Defaults to true. */
    enabled?: boolean;
  } = {}
) {
  const { sortOrder = 'asc', encryptionKey, enabled = true } = options;

  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;

  const hydrateEvents = useCallback(async (rawEvents: Event[]) => {
    const key = encryptionKeyRef.current;
    return Promise.all(rawEvents.map((ev) => hydrateResourceIOAsync(ev, key)));
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await unwrapOrThrow(
        fetchEvents(env, runId, {
          cursor,
          sortOrder,
          limit: PAGE_SIZE,
          withData: false,
        })
      );
      return { ...page, data: await hydrateEvents(page.data) };
    },
    [env, runId, sortOrder, hydrateEvents]
  );

  // Pages are cached per query, so re-entering the tab restores the rows it
  // had loaded. A query seen for the first time starts empty.
  const listKey = enabled ? `run-events:${runId}:${sortOrder}` : null;
  const list = useInfiniteList(listKey, fetchPage, getEventId, {
    keepPreviousData: false,
  });

  // How the rows on screen were read: the query, and whether a key was there
  // to decrypt them. Restored rows may be stale, and rows read before the key
  // arrived were hydrated without it, so a change reads them again in place.
  const reading =
    listKey && `${listKey}:${encryptionKey ? 'decrypted' : 'encrypted'}`;
  const { revalidate } = list;
  useEffect(() => {
    if (reading) revalidate();
  }, [reading, revalidate]);

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
