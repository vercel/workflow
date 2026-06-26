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

export type FetchSpanDetail = (
  selection: SpanSelectionInfo
) => Promise<DetailResource>;

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
  displayData: Record<string, unknown>;
  detail: DetailResource | null;
  error: Error | undefined;
}

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
  }, [selectionKey, runId, needsFetch, fetchSpanDetail]);

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
