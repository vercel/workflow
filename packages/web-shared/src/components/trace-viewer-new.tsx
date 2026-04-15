import { useMemo } from 'react';
import type { WorkflowRun } from '@workflow/core/runtime';
import type { Event } from '@workflow/world';
import { buildTrace, type TraceWithMeta } from '../lib/trace-builder';
import { NewTraceViewer as NewTraceViewerComponent } from './new-trace-viewer/trace-viewer';
import {
  SidebarDataProvider,
  type SidebarDataContextValue,
} from './sidebar/sidebar-data-context';
import type { Trace } from './trace-viewer/types';

const NewTraceViewer = ({
  run,
  events,
  sidebarData,
}: {
  run: WorkflowRun;
  events: Event[];
  sidebarData: SidebarDataContextValue;
}) => {
  // Build trace only when actual data changes — no timer-driven rebuilds.
  // Active span widths are animated imperatively by useLiveTick at 60fps.
  const traceWithMeta: TraceWithMeta | undefined = useMemo(() => {
    if (!run?.runId) {
      return undefined;
    }
    return buildTrace(run, events, new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` is intentionally not a dep; useLiveTick handles live growth
  }, [run, events]);
  const trace = traceWithMeta;

  if (!trace) {
    return (
      <div className="relative w-full h-full flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading trace…</div>
      </div>
    );
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
