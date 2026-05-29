import type { WorkflowRun } from '@workflow/core/runtime';
import type { Event } from '@workflow/world';
import { useMemo } from 'react';
import { buildTrace, type TraceWithMeta } from '../lib/trace-builder';
import { TraceViewerSkeleton } from './new-trace-viewer/components/trace-viewer-skeleton';
import { NewTraceViewer as NewTraceViewerComponent } from './new-trace-viewer/trace-viewer';
import {
  type SidebarDataContextValue,
  SidebarDataProvider,
} from './sidebar/sidebar-data-context';
import type { Trace } from './trace-viewer/types';

const NewTraceViewer = ({
  run,
  events,
  sidebarData,
  loading = false,
}: {
  run: WorkflowRun;
  events: Event[];
  sidebarData: SidebarDataContextValue;
  loading?: boolean;
}) => {
  const traceWithMeta: TraceWithMeta | undefined = useMemo(() => {
    if (!run?.runId) {
      return undefined;
    }
    return buildTrace(run, events, new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` is intentionally not a dep
  }, [run, events]);
  const trace = traceWithMeta;

  if (!trace || (loading && events.length === 0)) {
    return <TraceViewerSkeleton />;
  }

  return (
    <SidebarDataProvider value={sidebarData}>
      <div className="relative w-full h-full flex">
        <NewTraceViewerComponent trace={trace as Trace} />
      </div>
    </SidebarDataProvider>
  );
};

export { NewTraceViewer };
