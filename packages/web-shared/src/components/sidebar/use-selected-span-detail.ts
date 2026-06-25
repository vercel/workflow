'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  SelectedSpanInfo,
  SpanSelectionInfo,
} from './entity-detail-panel';
import {
  deriveSpanDetailView,
  resourceNeedsFetchedDetail,
  type SpanDetailStatus,
} from './span-detail-merge';

export type DetailResource = WorkflowRun | Step | Hook | Event;

/**
 * Loads the full detail (input/output/metadata) for a selected span. Injected
 * by the host app, which owns the RPC/hydration/encryption layer — see
 * `fetchSpanDetailResource` in `@workflow/web`.
 */
export type FetchSpanDetail = (
  selection: SpanSelectionInfo
) => Promise<DetailResource>;

/**
 * Resolve a selected span to the `{ resource, resourceId, runId }` needed to
 * fetch its detail. Returns null for spans we can't (or don't need to) resolve.
 */
function deriveSpanSelection(
  selectedSpan: SelectedSpanInfo | null
): SpanSelectionInfo | null {
  if (!selectedSpan) return null;
  const { resource, data } = selectedSpan;

  if (
    resource === 'step' &&
    data &&
    typeof data === 'object' &&
    'stepId' in data
  ) {
    const step = data as Step;
    return { resource: 'step', resourceId: step.stepId, runId: step.runId };
  }
  if (
    resource === 'run' &&
    data &&
    typeof data === 'object' &&
    'runId' in data
  ) {
    return { resource: 'run', resourceId: (data as WorkflowRun).runId };
  }
  if (
    resource === 'hook' &&
    data &&
    typeof data === 'object' &&
    'hookId' in data
  ) {
    return { resource: 'hook', resourceId: (data as Hook).hookId };
  }
  if (resource === 'sleep') {
    if (!selectedSpan.spanId) return null;
    const waitData = data as { runId?: string } | undefined;
    return {
      resource: 'sleep',
      resourceId: selectedSpan.spanId,
      runId: waitData?.runId,
    };
  }
  return null;
}

export interface SelectedSpanDetailResult {
  status: SpanDetailStatus;
  resource: SpanSelectionInfo['resource'] | undefined;
  resourceId: string | undefined;
  runId: string | undefined;
  /** Inline span data merged with the matching fetched detail. */
  displayData: Record<string, unknown>;
  /** The fetched detail matching the current selection, else null. */
  detail: DetailResource | null;
  /** Error for the current selection, if the fetch failed. */
  error: Error | undefined;
}

/**
 * Single source of truth for the selected span's detail. It derives the
 * selection synchronously, fetches its detail directly (no notify-effect
 * round-trip through the host page), and returns a view-model whose `status`
 * is a pure function of (selection, fetched detail). Because `status` is
 * computed synchronously from the current selection, the panel is `loading`
 * from the first render after a new span is picked until its matching detail
 * arrives — which is what removes the Input/Output flicker.
 */
export function useSelectedSpanDetail(
  selectedSpan: SelectedSpanInfo | null,
  fetchSpanDetail: FetchSpanDetail
): SelectedSpanDetailResult {
  const selection = useMemo(
    () => deriveSpanSelection(selectedSpan),
    [selectedSpan]
  );
  const resource = selection?.resource;
  const resourceId = selection?.resourceId;
  const runId = selection?.runId;
  const selectionKey =
    resource && resourceId ? `${resource}:${resourceId}` : null;
  const needsFetch = resourceNeedsFetchedDetail(resource);

  const [fetched, setFetched] = useState<{
    detail: DetailResource | null;
    error: Error | null;
    errorKey: string | null;
  }>({ detail: null, error: null, errorKey: null });

  // Monotonic token so superseded / out-of-order responses are dropped. This
  // is what lets us safely fetch directly off the selection: a slow response
  // for a previously selected span can never overwrite the current one.
  const tokenRef = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!selectionKey || !needsFetch) {
      return;
    }
    const activeSelection = selectionRef.current;
    if (!activeSelection) {
      return;
    }
    const token = ++tokenRef.current;
    fetchSpanDetail(activeSelection)
      .then((detail) => {
        if (tokenRef.current !== token) return;
        setFetched({ detail, error: null, errorKey: null });
      })
      .catch((err: unknown) => {
        if (tokenRef.current !== token) return;
        setFetched({
          detail: null,
          error: err instanceof Error ? err : new Error(String(err)),
          errorKey: selectionKey,
        });
      });
    // `selectionKey` + `runId` capture the selection identity. `fetchSpanDetail`
    // changes only when env / encryption key change (e.g. Decrypt), which
    // should refetch while keeping prior data visible.
  }, [selectionKey, runId, needsFetch, fetchSpanDetail]);

  // Only surface an error that belongs to the current selection; a stale error
  // from a previously selected span must not bleed into the new one.
  const scopedError = fetched.errorKey === selectionKey ? fetched.error : null;

  const view = useMemo(
    () =>
      deriveSpanDetailView({
        resource,
        resourceId,
        inlineData: selectedSpan?.data,
        fetchedDetail: fetched.detail,
        fetchedError: scopedError,
      }),
    [resource, resourceId, selectedSpan?.data, fetched.detail, scopedError]
  );

  return {
    status: view.status,
    resource,
    resourceId,
    runId,
    displayData: view.displayData,
    detail: view.detail as DetailResource | null,
    error: view.error,
  };
}
