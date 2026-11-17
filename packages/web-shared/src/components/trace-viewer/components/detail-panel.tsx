'use client';

import { type ReactNode, type RefObject, useCallback, useMemo } from 'react';
import { filterSpanRawEvents } from '../../../lib/trace-builder';
import { ErrorBoundary } from '../../error-boundary';
import {
  EntityDetailPanel,
  type SelectedSpanInfo,
} from '../../sidebar/entity-detail-panel';
import { useSidebarData } from '../../sidebar/sidebar-data-context';
import { getSpanTitle } from '../../sidebar/span-name';
import { useActiveSpan } from '../context';
import { DetailPanelShell } from './detail-panel-shell';
import { useDetailPanelWidth } from './use-detail-panel-width';

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
 * The span detail aside: the selected span's details in `DetailPanelShell`,
 * which supplies the header, its J/K/Escape shortcuts and the resizable border.
 *
 * Always mounted (it renders null without a selection) and holds the panel
 * width, so the width survives closing and reopening within a session.
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
  const selectedSpan = useSelectedSpanInfo();
  const panelWidth = useDetailPanelWidth(containerRef, Boolean(activeSpan));

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

  const selectedSpanName = getSpanTitle(
    selectedSpan?.data,
    selectedSpan?.resource
  );

  if (!activeSpan) return null;

  return (
    <DetailPanelShell
      id={DETAIL_PANEL_ID}
      width={panelWidth}
      title={<span className="truncate block">{selectedSpanName}</span>}
      itemLabel="span"
      onPrev={prevSpanId ? handleSelectPrev : undefined}
      onNext={nextSpanId ? handleSelectNext : undefined}
      onClose={onClose}
    >
      <ErrorBoundary>
        <EntityDetailPanel selectedSpan={selectedSpan} />
      </ErrorBoundary>
    </DetailPanelShell>
  );
}
