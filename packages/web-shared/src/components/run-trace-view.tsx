'use client';

import type { Event, Hook, WorkflowRun } from '@workflow/world';
import { AlertCircle } from 'lucide-react';
import type { FetchSpanDetail } from './sidebar/use-selected-span-detail';
import { WorkflowTraceViewer } from './workflow-trace-view';

interface RunTraceViewProps {
  run: WorkflowRun;
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  fetchSpanDetail: FetchSpanDetail;
  onWakeUpSleep?: (
    runId: string,
    correlationId: string
  ) => Promise<{ stoppedCount: number }>;
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
  onCancelRun?: (runId: string) => Promise<void>;
  onStreamClick?: (streamId: string) => void;
  onRunClick?: (runId: string) => void;
  onLoadMoreSpans?: () => void | Promise<void>;
  hasMoreSpans?: boolean;
  isLoadingMoreSpans?: boolean;
}

export function RunTraceView({
  run,
  events,
  isLoading,
  error,
  fetchSpanDetail,
  onWakeUpSleep,
  onResolveHook,
  onCancelRun,
  onStreamClick,
  onRunClick,
  onLoadMoreSpans,
  hasMoreSpans,
  isLoadingMoreSpans,
}: RunTraceViewProps) {
  if (error && !run) {
    return (
      <div className="m-4">
        <AlertCircle className="h-4 w-4" />
        <p>Error loading workflow run</p>
        <p>{error.message}</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <WorkflowTraceViewer
        error={error}
        events={events}
        run={run}
        isLoading={isLoading}
        fetchSpanDetail={fetchSpanDetail}
        onWakeUpSleep={onWakeUpSleep}
        onResolveHook={onResolveHook}
        onCancelRun={onCancelRun}
        onStreamClick={onStreamClick}
        onRunClick={onRunClick}
        onLoadMoreSpans={onLoadMoreSpans}
        hasMoreSpans={hasMoreSpans}
        isLoadingMoreSpans={isLoadingMoreSpans}
      />
    </div>
  );
}
