import type { WorkflowRun } from '@workflow/core/runtime';
import type { Event } from '@workflow/world';
import { useMemo } from 'react';
import { buildTrace, type TraceWithMeta } from '../lib/trace-builder';
import {
  type WorkflowSpanTimingMap,
  withWorkflowSpanTimings,
} from '../lib/workflow-span-timing';
import { TraceViewerSkeleton } from './new-trace-viewer/components/trace-viewer-skeleton';
import { NewTraceViewer as NewTraceViewerComponent } from './new-trace-viewer/trace-viewer';
import {
  type SidebarDataContextValue,
  SidebarDataProvider,
} from './sidebar/sidebar-data-context';

const NewTraceViewer = ({
  run,
  events,
  sidebarData,
  onLoadMore,
  hasMore,
  isLoadingMore,
  loading = false,
  showWorkflowTimingBreakdown = false,
  spanTimings,
}: {
  run: WorkflowRun;
  events: Event[];
  sidebarData: SidebarDataContextValue;
  onLoadMore?: () => void | Promise<void>;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  loading?: boolean;
  showWorkflowTimingBreakdown?: boolean;
  spanTimings?: WorkflowSpanTimingMap;
}) => {
  const trace: TraceWithMeta | undefined = useMemo(() => {
    if (!run?.runId) {
      return undefined;
    }
    return withWorkflowSpanTimings(
      buildTrace(run, events, new Date()),
      spanTimings
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` is intentionally not a dep
  }, [run, events, spanTimings]);

  if (!trace || (loading && events.length === 0)) {
    return <TraceViewerSkeleton />;
  }

  return (
    <SidebarDataProvider value={sidebarData}>
      <div className="relative w-full h-full flex">
        <NewTraceViewerComponent
          trace={trace}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          showWorkflowTimingBreakdown={showWorkflowTimingBreakdown}
        />
      </div>
    </SidebarDataProvider>
  );
};

export { NewTraceViewer };
