'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useEffect, useRef, useState } from 'react';
import type { SpanSelectionInfo } from './entity-detail-panel';

export type SpanDetail = WorkflowRun | Step | Hook | Event | null;

export type FetchSpanDetail = (info: SpanSelectionInfo) => Promise<SpanDetail>;

interface SpanDetailState {
  data: SpanDetail;
  loading: boolean;
  error: Error | null;
}

const IDLE: SpanDetailState = { data: null, loading: false, error: null };

/**
 * Fetches the detail for the currently selected span, keyed to the selection
 * so the result can never belong to a different span than the one rendered.
 *
 * The fetch is async, so a result could land after the selection has moved
 * on. The effect is keyed on the selection (+ encryptionKey, which changes
 * hydration) and a per-run `ignore` flag drops any resolution from a
 * superseded selection, so data is only ever set for the current selection.
 *
 * `fetchSpanDetail` is read through a ref so a changing fetcher identity
 * (hosts close over trace events / encryption key) does not trigger a refetch
 * on its own — only an actual selection or encryptionKey change does.
 */
export function useSpanDetail(
  selection: SpanSelectionInfo | null,
  fetchSpanDetail: FetchSpanDetail | undefined,
  options: { encryptionKey?: Uint8Array } = {}
): SpanDetailState {
  const resource = selection?.resource;
  const resourceId = selection?.resourceId;
  const runId = selection?.runId;
  const { encryptionKey } = options;

  const [state, setState] = useState<SpanDetailState>(IDLE);

  const fetchRef = useRef(fetchSpanDetail);
  fetchRef.current = fetchSpanDetail;

  // Tracks the last resource+id so data is cleared on a selection change but
  // preserved across an encryptionKey-only refetch (decrypt keeps data visible).
  const prevSelectionKeyRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: encryptionKey re-runs the fetch when the decrypt key arrives; the fetcher reads it via closure on the host side
  useEffect(() => {
    const fetcher = fetchRef.current;
    if (!resource || !resourceId || !fetcher) {
      prevSelectionKeyRef.current = null;
      setState(IDLE);
      return;
    }

    const selectionKey = `${resource}:${resourceId}`;
    const selectionChanged = selectionKey !== prevSelectionKeyRef.current;
    prevSelectionKeyRef.current = selectionKey;

    setState((prev) => ({
      data: selectionChanged ? null : prev.data,
      loading: true,
      error: null,
    }));

    let ignore = false;
    fetcher({ resource, resourceId, runId })
      .then((data) => {
        if (!ignore) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!ignore) {
          setState({
            data: null,
            loading: false,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [resource, resourceId, runId, encryptionKey]);

  return state;
}
