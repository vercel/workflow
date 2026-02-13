'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { AlertCircle } from 'lucide-react';
import type { SpanSelectionInfo } from './sidebar/entity-detail-panel';
import { WorkflowTraceViewer } from './workflow-trace-view';

interface RunTraceViewProps {
  run: WorkflowRun;
  steps: Step[];
  hooks: Hook[];
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  spanDetailData?: WorkflowRun | Step | Hook | Event | null;
  spanDetailLoading?: boolean;
  spanDetailError?: Error | null;
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
  onSpanSelect?: (info: SpanSelectionInfo) => void;
}

export function RunTraceView({
  run,
  steps,
  hooks,
  events,
  isLoading,
  error,
  spanDetailData,
  spanDetailLoading,
  spanDetailError,
  onWakeUpSleep,
  onResolveHook,
  onCancelRun,
  onStreamClick,
  onSpanSelect,
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
        steps={steps}
        events={events}
        hooks={hooks}
        run={run}
        isLoading={isLoading}
        spanDetailData={spanDetailData}
        spanDetailLoading={spanDetailLoading}
        spanDetailError={spanDetailError}
        onWakeUpSleep={onWakeUpSleep}
        onResolveHook={onResolveHook}
        onCancelRun={onCancelRun}
        onStreamClick={onStreamClick}
        onSpanSelect={onSpanSelect}
      />
    </div>
  );
}
