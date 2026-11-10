'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import { filterSpanRawEvents } from '../../../lib/trace-builder';
import { ErrorBoundary } from '../../error-boundary';
import {
  EntityDetailPanel,
  type SelectedSpanInfo,
} from '../../sidebar/entity-detail-panel';
import { useSidebarData } from '../../sidebar/sidebar-data-context';
import { useActiveSpan } from '../context';
import { DetailPanelShell } from './detail-panel-shell';

const DETAIL_PANEL_ID = 'trace-detail-panel';

/** Bridge ActiveSpanContext + SidebarDataContext → SelectedSpanInfo. */
function useSelectedSpanInfo(): SelectedSpanInfo | null {
  const { activeSpan } = useActiveSpan();
  const sidebar = useSidebarData();

  return useMemo(() => {
    if (!activeSpan) return null;

    const resource = activeSpan.attributes?.resource as string | undefined;
    const rawEvents = filterSpanRawEvents(
      sidebar.events,
      resource,
      activeSpan.spanId
    );

    return {
      data: activeSpan.attributes?.data,
      resource,
      spanId: activeSpan.spanId,
      rawEvents,
      duplicateEventIds: sidebar.duplicateEventIds,
    };
  }, [activeSpan, sidebar]);
}

/**
 * The span detail aside: content, prev/next/close header, J/K navigation, and
 * the resizable left border with its width model (see detail-panel-width.ts).
 *
 * Always mounted (it renders null without a selection) so the panel width
 * survives closing and reopening within a session.
 */
export function TraceDetailPanel({
  containerRef,
  onNavigateToSpan,
  onClose,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  onNavigateToSpan: (spanId: string) => void;
  onClose: () => void;
}): ReactNode {
  const { activeSpan, activeSpanId, spans } = useActiveSpan();
  const sidebar = useSidebarData();
  const selectedSpan = useSelectedSpanInfo();
  const isOpen = Boolean(activeSpan);

  const { prevSpanId, nextSpanId } = useMemo(() => {
    if (!activeSpanId) return { prevSpanId: null, nextSpanId: null };
    const i = spans.findIndex((s) => s.spanId === activeSpanId);
    if (i === -1) return { prevSpanId: null, nextSpanId: null };
    return {
      prevSpanId: spans[i - 1]?.spanId ?? null,
      nextSpanId: spans[i + 1]?.spanId ?? null,
    };
  }, [activeSpanId, spans]);

  const handleSelectPrev = useCallback(() => {
    if (prevSpanId) onNavigateToSpan(prevSpanId);
  }, [prevSpanId, onNavigateToSpan]);

  const handleSelectNext = useCallback(() => {
    if (nextSpanId) onNavigateToSpan(nextSpanId);
  }, [nextSpanId, onNavigateToSpan]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (
        e.key !== 'j' &&
        e.key !== 'k' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowUp'
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      const targetId =
        e.key === 'k' || e.key === 'ArrowUp' ? prevSpanId : nextSpanId;
      if (targetId) {
        e.preventDefault();
        onNavigateToSpan(targetId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, prevSpanId, nextSpanId, onNavigateToSpan]);

  // Derive the selected span name for the panel header
  const selectedSpanName = useMemo(() => {
    if (!selectedSpan?.data) return 'Details';
    const data = selectedSpan.data as Record<string, unknown>;
    if (selectedSpan.resource === 'hook') {
      return (data.token as string | undefined) ?? (data.hookId as string);
    }

    const stepName = data.stepName as string | undefined;
    const workflowName = data.workflowName as string | undefined;
    return (
      (stepName ? parseStepName(stepName)?.shortName : undefined) ??
      (workflowName ? parseWorkflowName(workflowName)?.shortName : undefined) ??
      stepName ??
      workflowName ??
      (data.hookId as string) ??
      'Details'
    );
  }, [selectedSpan?.data, selectedSpan?.resource]);

  if (!activeSpan) return null;

  return (
    <DetailPanelShell
      id={DETAIL_PANEL_ID}
      containerRef={containerRef}
      title={<span className="truncate block">{selectedSpanName}</span>}
      itemLabel="span"
      onPrev={prevSpanId ? handleSelectPrev : undefined}
      onNext={nextSpanId ? handleSelectNext : undefined}
      onClose={onClose}
    >
      <ErrorBoundary>
        <EntityDetailPanel
          run={sidebar.run}
          onStreamClick={sidebar.onStreamClick}
          onRunClick={sidebar.onRunClick}
          fetchSpanDetail={sidebar.fetchSpanDetail}
          onWakeUpSleep={sidebar.onWakeUpSleep}
          onLoadEventData={sidebar.onLoadEventData}
          onResolveHook={sidebar.onResolveHook}
          encryptionKey={sidebar.encryptionKey}
          onDecrypt={sidebar.onDecrypt}
          isDecrypting={sidebar.isDecrypting}
          isDecryptDisabled={sidebar.isDecryptDisabled}
          decryptDisabledReason={sidebar.decryptDisabledReason}
          selectedSpan={selectedSpan}
          showSeparateEventOccurrenceTimestamps={
            sidebar.showSeparateEventOccurrenceTimestamps
          }
          getModuleSourceUrl={sidebar.getModuleSourceUrl}
        />
      </ErrorBoundary>
    </DetailPanelShell>
  );
}
