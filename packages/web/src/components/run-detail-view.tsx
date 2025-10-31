'use client';

import { parseWorkflowName } from '@workflow/core/parse-name';
import {
  cancelRun,
  recreateRun,
  useWorkflowTraceViewerData,
  type WorkflowRun,
  WorkflowTraceViewer,
} from '@workflow/web-shared';
import { AlertCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buildUrlWithConfig, worldConfigToEnvMap } from '@/lib/config';
import type { WorldConfig } from '@/lib/config-world';
import { BackLink } from './display-utils/back-link';
import { CancelButton } from './display-utils/cancel-button';
import { CopyableText } from './display-utils/copyable-text';
import { LiveStatus } from './display-utils/live-status';
import { RelativeTime } from './display-utils/relative-time';
import { RerunButton } from './display-utils/rerun-button';
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
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showRerunDialog, setShowRerunDialog] = useState(false);
  const env = useMemo(() => worldConfigToEnvMap(config), [config]);

  // Fetch all run data with live updates
  const {
    run: runData,
    steps: allSteps,
    hooks: allHooks,
    events: allEvents,
    loading,
    error,
    update,
  } = useWorkflowTraceViewerData(env, runId, { live: true });
  const run = runData ?? ({} as WorkflowRun);

  const handleCancelClick = () => {
    setShowCancelDialog(true);
  };

  const handleConfirmCancel = async () => {
    if (cancelling) return;

    try {
      setCancelling(true);
      setShowCancelDialog(false);
      await cancelRun(env, runId);
      // Trigger a refresh of the data
      await update();
      toast.success('Run cancelled successfully');
    } catch (err) {
      console.error('Failed to cancel run:', err);
      toast.error('Failed to cancel run', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setCancelling(false);
    }
  };

  const handleRerunClick = () => {
    setShowRerunDialog(true);
  };

  const handleConfirmRerun = async () => {
    if (rerunning) return;

    try {
      setRerunning(true);
      setShowRerunDialog(false);
      // Start a new run with the same workflow and input arguments
      const newRunId = await recreateRun(env, run.runId);
      toast.success('New run started successfully', {
        description: `Run ID: ${newRunId}`,
      });
      // Navigate to the new run
      router.push(buildUrlWithConfig(`/run/${newRunId}`, config));
    } catch (err) {
      console.error('Failed to re-run workflow:', err);
      toast.error('Failed to start new run', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setRerunning(false);
      setShowRerunDialog(false);
    }
  };

  if (error && !runData) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error loading workflow run</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
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

  // Determine if re-run is allowed and why
  const isRunActive = run.status === 'pending' || run.status === 'running';
  const canRerun = !loading && !isRunActive && !rerunning;
  const getRerunDisabledReason = () => {
    if (rerunning) return 'Re-running workflow...';
    if (loading) return 'Loading run data...';
    if (isRunActive) return 'Cannot re-run while workflow is still running';
    return '';
  };
  const rerunDisabledReason = getRerunDisabledReason();

  return (
    <>
      {/* Cancel Confirmation Dialog */}
      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Workflow Run?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop the workflow execution immediately, and no further
              steps will be executed. Partial workflow execution may occur. Are
              you sure you want to cancel the run?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Running</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Re-run Confirmation Dialog */}
      <AlertDialog open={showRerunDialog} onOpenChange={setShowRerunDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-run Workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              This can potentially re-run code that is meant to only execute
              once. Are you sure you want to re-run the workflow?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRerun}>
              Re-run Workflow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              <RerunButton
                canRerun={canRerun}
                rerunning={rerunning}
                rerunDisabledReason={rerunDisabledReason}
                onRerun={handleRerunClick}
              />
              <CancelButton
                canCancel={canCancel}
                cancelling={cancelling}
                cancelDisabledReason={cancelDisabledReason}
                onCancel={handleCancelClick}
              />
            </div>
          </div>

          {/* Status and Timeline Row */}
          <div className="flex items-start gap-8">
            <div className="flex flex-col gap-1">
              <div className="text-xs text-muted-foreground">Status</div>
              <StatusBadge status={run.status || '...'} context={run} />
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
                {run.completedAt ? (
                  <RelativeTime date={run.completedAt} />
                ) : (
                  '-'
                )}
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
            error={error}
            steps={allSteps}
            events={allEvents}
            hooks={allHooks}
            env={env}
            run={run}
            isLoading={loading}
          />
        </div>
      </div>
    </>
  );
}
