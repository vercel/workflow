'use client';

import type { Event } from '@workflow/world';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EventSearchState } from '../../lib/event-list-model';
import {
  type ExactIdSearchResult,
  type ExactWorkflowSearchIdKind,
  parseExactWorkflowSearchId,
} from '../../lib/exact-event-search-id';

/** How long typing has to pause before an exact-ID lookup is sent. */
const EXACT_SEARCH_DEBOUNCE_MS = 300;

type ExactSearchAnswer =
  | { status: 'ok'; events: Event[]; truncated: boolean }
  | { status: 'not_found' }
  | { status: 'error'; message?: string };

/** A settled exact-ID lookup, for the query and attempt it answered. */
type ExactSearchOutcome = {
  query: string;
  attempt: number;
  answer: ExactSearchAnswer;
};

export type ExactSearchHandler = (
  id: string,
  kind: ExactWorkflowSearchIdKind,
  signal?: AbortSignal
) => Promise<ExactIdSearchResult>;

/**
 * The Events tab search box. The input text is the only thing typed; the
 * search state is derived from it plus the latest settled exact-ID lookup, so
 * a lookup that answered an older query or attempt is never shown for the
 * current one.
 */
export function useEventSearch(onExactIdSearch?: ExactSearchHandler): {
  query: string;
  setQuery: (query: string) => void;
  search: EventSearchState;
  retry: () => void;
} {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<ExactSearchOutcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  const trimmed = query.trim();
  const parsed = useMemo(() => parseExactWorkflowSearchId(trimmed), [trimmed]);

  useEffect(() => {
    if (!parsed || !onExactIdSearch) return;

    // Aborted when the query changes, so a superseded lookup never settles.
    const abortController = new AbortController();
    const timer = setTimeout(async () => {
      let answer: ExactSearchAnswer;
      try {
        const result = await onExactIdSearch(
          parsed.id,
          parsed.kind,
          abortController.signal
        );
        if (result.status === 'error') {
          answer = result;
        } else if (
          result.status === 'not_found' ||
          result.events.length === 0
        ) {
          answer = { status: 'not_found' };
        } else {
          answer = {
            status: 'ok',
            events: result.events,
            truncated: Boolean(result.truncated),
          };
        }
      } catch {
        answer = { status: 'error' };
      }
      if (!abortController.signal.aborted) {
        setOutcome({ query: trimmed, attempt, answer });
      }
    }, EXACT_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortController.abort();
      // Coming back to this query looks it up again rather than showing the
      // answer it had before.
      setOutcome(null);
    };
  }, [trimmed, parsed, onExactIdSearch, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const search = useMemo((): EventSearchState => {
    if (!trimmed) return { status: 'idle' };
    if (!parsed) {
      return { status: 'incomplete', query: trimmed };
    }
    if (!onExactIdSearch) return { status: 'unavailable', query: trimmed };
    if (outcome?.query !== trimmed || outcome.attempt !== attempt) {
      return { status: 'loading', query: trimmed, id: parsed };
    }
    return { ...outcome.answer, query: trimmed, id: parsed };
  }, [trimmed, parsed, onExactIdSearch, outcome, attempt]);

  return { query, setQuery, search, retry };
}
