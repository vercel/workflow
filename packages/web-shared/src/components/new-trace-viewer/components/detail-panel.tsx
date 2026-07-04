'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { filterSpanRawEvents } from '../../../lib/trace-builder';
import { ErrorBoundary } from '../../error-boundary';
import {
  EntityDetailPanel,
  type SelectedSpanInfo,
} from '../../sidebar/entity-detail-panel';
import { useSidebarData } from '../../sidebar/sidebar-data-context';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { useActiveSpan } from '../context';
import {
  clampPanelWidth,
  computeMaxPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  readStoredPanelWidth,
  writeStoredPanelWidth,
} from './detail-panel-width';
import { DraggableBorder } from './draggable-border';
import { useElementWidth } from './use-element-width';

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
    };
  }, [activeSpan, sidebar]);
}

/**
 * The span detail aside: content, prev/next/close header, J/K navigation, and
 * the resizable left border with its width model (see detail-panel-width.ts).
 *
 * Always mounted — it renders null without a selection — so the panel width
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

  const [storedWidth, setStoredWidth] = useState<number>(() =>
    readStoredPanelWidth()
  );
  const containerWidth = useElementWidth(containerRef, isOpen);
  const asideRef = useRef<HTMLDivElement | null>(null);

  const handleResize = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next, containerWidth);
      setStoredWidth(clamped);
      writeStoredPanelWidth(clamped);
    },
    [containerWidth]
  );

  const panelWidth = clampPanelWidth(storedWidth, containerWidth);
  const panelMaxWidth = Math.max(
    PANEL_MIN_WIDTH,
    computeMaxPanelWidth(containerWidth)
  );

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
    <aside
      ref={asideRef}
      id={DETAIL_PANEL_ID}
      className="relative flex flex-col h-full max-h-full shrink-0 bg-background-100 border-l border-gray-alpha-400"
      style={{ width: panelWidth }}
    >
      <DraggableBorder
        element={asideRef}
        position="left"
        onWidthChange={handleResize}
        onReset={() => handleResize(PANEL_DEFAULT_WIDTH)}
        aria-label="Resize span details panel"
        aria-controls={DETAIL_PANEL_ID}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={panelMaxWidth}
        aria-valuenow={Math.min(
          Math.max(Math.round(panelWidth), PANEL_MIN_WIDTH),
          panelMaxWidth
        )}
      />
      {/* Panel header */}
      <div className="flex items-center justify-between gap-2 shrink-0 px-4 py-[7.5px]">
        <span className="text-label-14 font-medium text-gray-1000 truncate block">
          {selectedSpanName}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Navigate up"
                aria-keyshortcuts="K"
                onClick={handleSelectPrev}
                disabled={!prevSpanId}
              >
                <ChevronUp className="w-4 h-4" />
              </IconButton>
            </TooltipTrigger>
            {prevSpanId ? (
              <TooltipContent>
                Navigate up
                <Kbd>K</Kbd>
              </TooltipContent>
            ) : null}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Navigate down"
                aria-keyshortcuts="J"
                onClick={handleSelectNext}
                disabled={!nextSpanId}
              >
                <ChevronDown className="w-4 h-4" />
              </IconButton>
            </TooltipTrigger>
            {nextSpanId ? (
              <TooltipContent>
                Navigate down
                <Kbd>J</Kbd>
              </TooltipContent>
            ) : null}
          </Tooltip>
          <div aria-hidden className="w-px h-4 bg-gray-alpha-400 mx-1" />
          <IconButton
            aria-label="Close span details"
            aria-keyshortcuts="Escape"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
      {/* Panel body */}
      <div className="flex-1 overflow-y-auto">
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
            selectedSpan={selectedSpan}
            showSeparateEventOccurrenceTimestamps={
              sidebar.showSeparateEventOccurrenceTimestamps
            }
          />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
