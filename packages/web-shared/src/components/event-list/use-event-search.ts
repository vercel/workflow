'use client';

import type { Event } from '@workflow/world';
import { useEffect, useMemo, useState } from 'react';
import type { EventSearchState } from '../../lib/event-list-model';
import {
  type ExactIdSearchResult,
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
 */
export function useEventSearch(onExactIdSearch?: ExactSearchHandler): {
  query: string;
  setQuery: (query: string) => void;
  search: EventSearchState;
} {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<ExactSearchOutcome | null>(null);

  const trimmed = query.trim();
  const parsed = useMemo(() => parseExactWorkflowSearchId(trimmed), [trimmed]);

  useEffect(() => {
    if (!parsed || !onExactIdSearch) return;

    // Aborted when the query changes, so a superseded lookup never settles.
    const abortController = new AbortController();
    const timer = setTimeout(async () => {
      let next: ExactSearchOutcome;
      try {
        const result = await onExactIdSearch(
          parsed.id,
          parsed.kind,
          abortController.signal
        );
        if (result.status === 'error') {
          next = { query: trimmed, status: 'error', message: result.message };
        } else if (
          result.status === 'not_found' ||
          result.events.length === 0
        ) {
          next = { query: trimmed, status: 'not_found' };
        } else {
          next = {
            query: trimmed,
            status: 'ok',
            events: result.events,
            truncated: Boolean(result.truncated),
          };
        }
      } catch {
        next = {
          query: trimmed,
          status: 'error',
          message: 'Failed to search events. Try again.',
        };
      }
      if (!abortController.signal.aborted) setOutcome(next);
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
