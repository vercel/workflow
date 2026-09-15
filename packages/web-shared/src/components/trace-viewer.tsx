import type { WorkflowRun } from '@workflow/core/runtime';
import type { Event } from '@workflow/world';
import { useMemo } from 'react';
import { buildTrace, type TraceWithMeta } from '../lib/trace-builder';
import {
  type SidebarDataContextValue,
  SidebarDataProvider,
} from './sidebar/sidebar-data-context';
import { TraceViewerSkeleton } from './trace-viewer/components/trace-viewer-skeleton';
import { TraceViewer as TraceViewerComponent } from './trace-viewer/trace-viewer';
import type { GetStepAttributes } from './workflow-traces/trace-span-construction';

const TraceViewer = ({
  run,
  events,
  sidebarData,
  onLoadMore,
  hasMore,
  isLoadingMore,
  loading = false,
  getStepAttributes,
}: {
  run: WorkflowRun;
  events: Event[];
  sidebarData: SidebarDataContextValue;
  onLoadMore?: () => void | Promise<void>;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  loading?: boolean;
  /** Adds product-specific attributes to event-derived step span data. */
  getStepAttributes?: GetStepAttributes;
}) => {
  const trace: TraceWithMeta | undefined = useMemo(() => {
    if (!run?.runId) {
      return undefined;
    }
    // `hasMore` is the only place that knows whether more of the log is still
    // to be fetched, and a repeat can only be told apart from the event it
    // repeats with the whole log in hand.
    return buildTrace(run, events, new Date(), {
      isCompleteHistory: !hasMore,
      getStepAttributes,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` is intentionally not a dep
  }, [run, events, hasMore, getStepAttributes]);

  // The sidebar shows one entity's slice of the log, so it takes the trace's
  // answer rather than recomputing one from the slice.
  const sidebarValue = useMemo(
    () => ({ ...sidebarData, duplicateEventIds: trace?.duplicateEventIds }),
    [sidebarData, trace]
  );

  if (!trace || (loading && events.length === 0)) {
    return <TraceViewerSkeleton />;
  }

  return (
    <SidebarDataProvider value={sidebarValue}>
      <div className="relative w-full h-full flex">
        <TraceViewerComponent
          trace={trace}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
        />
      </div>
    </SidebarDataProvider>
  );
};

export { TraceViewer };
