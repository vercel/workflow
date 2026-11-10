'use client';

import type { Event } from '@workflow/world';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventSearchState } from '../../lib/event-list-model';
import {
  type ExactIdSearchResult,
  type ExactWorkflowSearchId,
  type ExactWorkflowSearchIdKind,
  parseExactWorkflowSearchId,
} from '../../lib/exact-event-search-id';

/** How long typing has to pause before an exact-ID lookup is sent. */
const EXACT_SEARCH_DEBOUNCE_MS = 300;

/** A settled exact-ID lookup, for the query it answered. */
type ExactSearchOutcome = { query: string } & (
  | { status: 'ok'; events: Event[]; truncated: boolean }
  | { status: 'not_found' }
  | { status: 'error'; message: string }
);

export type ExactSearchHandler = (
  id: string,
  kind: ExactWorkflowSearchIdKind,
  signal?: AbortSignal
) => Promise<ExactIdSearchResult>;

/**
 * The Events tab search box. The input text is the only thing typed; the
 * search state is derived from it plus the latest settled exact-ID lookup, so
 * a lookup that answered an older query is never shown for the current one.
 *
 * `onExactResult` is called with the events of an exact-ID lookup when it
 * finds some, and with null when the search is cleared or a lookup finds
 * nothing or fails.
 */
export function useEventSearch({
  onExactIdSearch,
  onExactResult,
}: {
  onExactIdSearch?: ExactSearchHandler;
  onExactResult?: (
    result: { id: ExactWorkflowSearchId; events: Event[] } | null
  ) => void;
}): {
  query: string;
  setQuery: (query: string) => void;
  search: EventSearchState;
} {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<ExactSearchOutcome | null>(null);
  const requestRef = useRef(0);
  const onExactResultRef = useRef(onExactResult);
  onExactResultRef.current = onExactResult;

  const trimmed = query.trim();
  const parsed = useMemo(() => parseExactWorkflowSearchId(trimmed), [trimmed]);

  useEffect(() => {
    if (!trimmed) {
      requestRef.current += 1;
      onExactResultRef.current?.(null);
      return;
    }
    if (!parsed || !onExactIdSearch) return;

    const requestId = ++requestRef.current;
    const abortController = new AbortController();
    const isCurrent = () =>
      !abortController.signal.aborted && requestRef.current === requestId;
    const settle = (next: ExactSearchOutcome) => {
      setOutcome(next);
      onExactResultRef.current?.(
        next.status === 'ok' ? { id: parsed, events: next.events } : null
      );
    };

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await onExactIdSearch(
            parsed.id,
            parsed.kind,
            abortController.signal
          );
          if (!isCurrent()) return;
          if (result.status === 'error') {
            settle({
              query: trimmed,
              status: 'error',
              message: result.message,
            });
          } else if (
            result.status === 'not_found' ||
            result.events.length === 0
          ) {
            settle({ query: trimmed, status: 'not_found' });
          } else {
            settle({
              query: trimmed,
              status: 'ok',
              events: result.events,
              truncated: Boolean(result.truncated),
            });
          }
        } catch {
          if (!isCurrent()) return;
          settle({
            query: trimmed,
            status: 'error',
            message: 'Failed to search events. Try again.',
          });
        }
      })();
    }, EXACT_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortController.abort();
      // Coming back to this query looks it up again rather than showing the
      // answer it had before.
      setOutcome(null);
    };
  }, [trimmed, parsed, onExactIdSearch]);

  const search = useMemo((): EventSearchState => {
    if (!trimmed) return { status: 'idle' };
    if (!parsed) {
      return { status: 'incomplete', query: trimmed };
    }
    if (!onExactIdSearch) return { status: 'unavailable', query: trimmed };
    if (outcome?.query !== trimmed) {
      return { status: 'loading', query: trimmed, id: parsed };
    }
    return { ...outcome, id: parsed };
  }, [trimmed, parsed, onExactIdSearch, outcome]);

  return { query, setQuery, search };
}
