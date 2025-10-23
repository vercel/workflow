'use client';

import { parseWorkflowName } from '@workflow/core/parse-name';
import { useMemo, useState } from 'react';
import { buildUrlWithConfig, worldConfigToEnvMap } from '@/lib/config';
import type { WorldConfig } from '@/lib/config-world';
import {
  cancelRun,
  useWorkflowTraceViewerData,
  WorkflowTraceViewer,
} from '@/workflow-trace-viewer';
import { BackLink } from './display-utils/back-link';
import { CancelButton } from './display-utils/cancel-button';
import { CopyableText } from './display-utils/copyable-text';
import { LiveStatus } from './display-utils/live-status';
import { RelativeTime } from './display-utils/relative-time';
import { StatusBadge } from './display-utils/status-badge';

interface RunDetailViewProps {
  config: WorldConfig;
  runId: string;
  selectedId?: string;
}

export function RunDetailView({
  config,
  runId,
  // TODO: This should open the right sidebar within the trace viewer
  selectedId: _selectedId,
}: RunDetailViewProps) {
  const [cancelling, setCancelling] = useState(false);
  const env = useMemo(() => worldConfigToEnvMap(config), [config]);

  // Fetch all run data with live updates
  const {
    run,
    steps: allSteps,
    hooks: allHooks,
    events: allEvents,
    loading,
    error,
    update,
  } = useWorkflowTraceViewerData(env, runId, { live: true });

  const handleCancelRun = async () => {
    if (cancelling) return;

    try {
      setCancelling(true);
      await cancelRun(env, runId);
      // Trigger a refresh of the data
      await update();
    } catch (err) {
      console.error('Failed to cancel run:', err);
      // TODO: Show error toast/notification
    } finally {
      setCancelling(false);
    }
  };

  if (error) {
    return <div className="text-center py-8">Error: {error.message}</div>;
  }

  const workflowName = parseWorkflowName(run.workflowName)?.shortName || '?';

  // At this point, we've already returned if there was an error
  // So hasError is always false here
  const hasError = false;
  const errorMessage = '';

  // Determine if cancel is allowed and why
  const canCancel = run.status === 'pending' || run.status === 'running';
  const getCancelDisabledReason = () => {
    if (cancelling) return 'Cancelling run...';
    if (run.status === 'completed') return 'Run has already completed';
    if (run.status === 'failed') return 'Run has already failed';
    if (run.status === 'cancelled') return 'Run has already been cancelled';
    return '';
  };
  const cancelDisabledReason = getCancelDisabledReason();

  return (
    <div className="space-y-6">
      <BackLink href={buildUrlWithConfig('/', config)} />

      {/* Run Overview Header */}
      <div className="space-y-4 pb-6 border-b">
        {/* Title Row */}
        <div className="flex items-start justify-between">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold">{workflowName}</h1>
          </div>

          <div className="flex items-center justify-between gap-2">
            {/* Right side controls */}
            <LiveStatus hasError={hasError} errorMessage={errorMessage} />
            <CancelButton
              canCancel={canCancel}
              cancelling={cancelling}
              cancelDisabledReason={cancelDisabledReason}
              onCancel={handleCancelRun}
            />
          </div>
        </div>

        {/* Status and Timeline Row */}
        <div className="flex items-start gap-8">
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">Status</div>
            <StatusBadge status={run.status} context={run} />
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">Run ID</div>
            <CopyableText text={run.runId}>
              <div className="text-sm mt-0.5 font-mono">{run.runId}</div>
            </CopyableText>
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">Queued</div>
            <div className="text-sm">
              {run.createdAt ? <RelativeTime date={run.createdAt} /> : '-'}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">Started</div>
            <div className="text-sm">
              {run.startedAt ? <RelativeTime date={run.startedAt} /> : '-'}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">Completed</div>
            <div className="text-sm">
              {run.completedAt ? <RelativeTime date={run.completedAt} /> : '-'}
            </div>
          </div>
        </div>
      </div>

      <div className="relative">
        {loading && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white"></div>
          </div>
        )}
        <WorkflowTraceViewer
          steps={allSteps}
          events={allEvents}
          hooks={allHooks}
          env={env}
          run={run}
          isLoading={loading}
        />
      </div>
    </div>
  );
}
