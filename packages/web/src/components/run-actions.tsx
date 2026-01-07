'use client';

import {
  analyzeEvents,
  cancelRun,
  type EnvMap,
  type Event,
  recreateRun,
  reenqueueRun,
  wakeUpRun,
} from '@workflow/web-shared';
import type { WorkflowRunStatus } from '@workflow/world';
import {
  AlarmClockOff,
  Loader2,
  MoreHorizontal,
  RotateCw,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from './ui/button';

// ============================================================================
// Shared Props and Types
// ============================================================================

export interface RunActionCallbacks {
  onSuccess?: () => void;
  onNavigateToRun?: (runId: string) => void;
}

export interface RunActionsBaseProps {
  env: EnvMap;
  runId: string;
  runStatus: WorkflowRunStatus | undefined;
  events?: Event[];
  eventsLoading?: boolean;
  callbacks?: RunActionCallbacks;
}

// ============================================================================
// Shared Hook for Run Actions
// ============================================================================

interface UseRunActionsOptions {
  env: EnvMap;
  runId: string;
  runStatus: WorkflowRunStatus | undefined;
  events?: Event[];
  callbacks?: RunActionCallbacks;
}

function useRunActions({
  env,
  runId,
  runStatus,
  events,
  callbacks,
}: UseRunActionsOptions) {
  const [rerunning, setRerunning] = useState(false);
  const [reenqueuing, setReenqueuing] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const eventAnalysis = useMemo(() => analyzeEvents(events), [events]);
  const hasPendingSleeps = eventAnalysis.hasPendingSleeps;

  const handleReplay = useCallback(async () => {
    if (rerunning) return null;

    try {
      setRerunning(true);
      const newRunId = await recreateRun(env, runId);
      toast.success('New run started', {
        description: `Run ID: ${newRunId}`,
      });
      callbacks?.onSuccess?.();
      callbacks?.onNavigateToRun?.(newRunId);
      return newRunId;
    } catch (err) {
      toast.error('Failed to re-run', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
      return null;
    } finally {
      setRerunning(false);
    }
  }, [env, runId, rerunning, callbacks]);

  const handleReenqueue = useCallback(async () => {
    if (reenqueuing) return;

    try {
      setReenqueuing(true);
      await reenqueueRun(env, runId);
      toast.success('Run re-enqueued', {
        description: 'The workflow orchestration layer has been re-enqueued.',
      });
      callbacks?.onSuccess?.();
    } catch (err) {
      toast.error('Failed to re-enqueue', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setReenqueuing(false);
    }
  }, [env, runId, reenqueuing, callbacks]);

  const handleWakeUp = useCallback(async () => {
    if (wakingUp) return;

    try {
      setWakingUp(true);
      const result = await wakeUpRun(env, runId);
      if (result.stoppedCount > 0) {
        toast.success('Active sleeps cancelled', {
          description: `Cancelled ${result.stoppedCount} active sleep${result.stoppedCount > 1 ? 's' : ''} and resumed the run.`,
        });
      } else {
        toast.info('No active sleeps', {
          description: 'There were no active sleep calls to cancel.',
        });
      }
      callbacks?.onSuccess?.();
    } catch (err) {
      toast.error('Failed to cancel sleeps', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setWakingUp(false);
    }
  }, [env, runId, wakingUp, callbacks]);

  const handleCancel = useCallback(async () => {
    if (cancelling) return;

    const isRunActive = runStatus === 'pending' || runStatus === 'running';
    if (!isRunActive) {
      toast.error('Cannot cancel', {
        description: 'Only active runs can be cancelled',
      });
      return;
    }

    try {
      setCancelling(true);
      await cancelRun(env, runId);
      toast.success('Run cancelled');
      callbacks?.onSuccess?.();
    } catch (err) {
      toast.error('Failed to cancel', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setCancelling(false);
    }
  }, [env, runId, runStatus, cancelling, callbacks]);

  return {
    // State
    rerunning,
    reenqueuing,
    wakingUp,
    cancelling,
    hasPendingSleeps,
    // Handlers
    handleReplay,
    handleReenqueue,
    handleWakeUp,
    handleCancel,
  };
}

// ============================================================================
// Shared Tooltip Content
// ============================================================================

function CancelSleepsTooltipContent({
  hasPendingSleeps,
}: {
  hasPendingSleeps: boolean;
}) {
  if (!hasPendingSleeps) {
    return <>No active sleep calls to cancel.</>;
  }
  return (
    <>
      Cancel any active <code>sleep</code> calls and resume the run immediately.
    </>
  );
}

function ReenqueueTooltipContent() {
  return (
    <>
      Re-enqueue the workflow orchestration layer. Use this if the workflow
      appears stuck with no active steps. This is a no-op for healthy workflows.
    </>
  );
}

// ============================================================================
// Dropdown Menu Items (for runs-table)
// ============================================================================

export interface RunActionsDropdownItemsProps extends RunActionsBaseProps {
  /** Stop click event propagation (useful in table rows) */
  stopPropagation?: boolean;
}

export function RunActionsDropdownItems({
  env,
  runId,
  runStatus,
  events,
  eventsLoading,
  callbacks,
  stopPropagation = false,
}: RunActionsDropdownItemsProps) {
  const {
    rerunning,
    reenqueuing,
    wakingUp,
    cancelling,
    hasPendingSleeps,
    handleReplay,
    handleReenqueue,
    handleWakeUp,
    handleCancel,
  } = useRunActions({ env, runId, runStatus, events, callbacks });

  const onReplay = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    handleReplay();
  };

  const onReenqueue = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    handleReenqueue();
  };

  const onCancelSleeps = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    handleWakeUp();
  };

  const onCancel = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    handleCancel();
  };

  const isRunActive = runStatus === 'pending' || runStatus === 'running';

  return (
    <>
      <DropdownMenuItem onClick={onReplay} disabled={rerunning}>
        <RotateCw className="h-4 w-4 mr-2" />
        {rerunning ? 'Replaying...' : 'Replay Run'}
      </DropdownMenuItem>

      {/* Re-enqueue - always shown */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem
            onClick={onReenqueue}
            disabled={eventsLoading || reenqueuing}
          >
            <Zap className="h-4 w-4 mr-2" />
            {reenqueuing ? 'Re-enqueuing...' : 'Re-enqueue'}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          <ReenqueueTooltipContent />
        </TooltipContent>
      </Tooltip>

      {/* Cancel Active Sleeps - disabled if no active sleeps */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem
            onClick={onCancelSleeps}
            disabled={eventsLoading || !hasPendingSleeps || wakingUp}
          >
            <AlarmClockOff className="h-4 w-4 mr-2" />
            {wakingUp ? 'Cancelling sleeps...' : 'Cancel Active Sleeps'}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          <CancelSleepsTooltipContent hasPendingSleeps={hasPendingSleeps} />
        </TooltipContent>
      </Tooltip>

      <DropdownMenuItem
        onClick={onCancel}
        disabled={!isRunActive || cancelling}
      >
        <XCircle className="h-4 w-4 mr-2" />
        {cancelling ? 'Cancelling...' : 'Cancel'}
      </DropdownMenuItem>
    </>
  );
}

// ============================================================================
// Buttons (for run-detail-view)
// ============================================================================

export interface RunActionsButtonsProps extends RunActionsBaseProps {
  loading?: boolean;
  /** Called when cancel button is clicked - typically shows a confirmation dialog */
  onCancelClick?: () => void;
  /** Called when rerun button is clicked - typically shows a confirmation dialog */
  onRerunClick?: () => void;
}

export function RunActionsButtons({
  env,
  runId,
  runStatus,
  events,
  eventsLoading,
  loading,
  callbacks,
  onCancelClick,
  onRerunClick,
}: RunActionsButtonsProps) {
  const {
    reenqueuing,
    wakingUp,
    hasPendingSleeps,
    handleReenqueue,
    handleWakeUp,
  } = useRunActions({ env, runId, runStatus, events, callbacks });

  const isRunActive = runStatus === 'pending' || runStatus === 'running';
  const canCancel = isRunActive;

  // Rerun button logic
  const canRerun = !loading && !isRunActive;
  const rerunDisabledReason = loading
    ? 'Loading run data...'
    : isRunActive
      ? 'Cannot re-run while workflow is still running'
      : '';

  // Cancel button logic
  const cancelDisabledReason =
    runStatus === 'completed'
      ? 'Run has already completed'
      : runStatus === 'failed'
        ? 'Run has already failed'
        : runStatus === 'cancelled'
          ? 'Run has already been cancelled'
          : '';

  return (
    <>
      {/* Rerun Button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="outline"
              size="sm"
              onClick={onRerunClick}
              disabled={!canRerun}
            >
              <RotateCw className="h-4 w-4" />
              Replay
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {rerunDisabledReason ? (
            <p>{rerunDisabledReason}</p>
          ) : (
            <p>
              This will start a new copy of the current run using the same
              deployment, environment, and inputs. It will not affect the
              current run.
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      {/* Cancel Button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="outline"
              size="sm"
              onClick={onCancelClick}
              disabled={!canCancel}
            >
              <XCircle className="h-4 w-4" />
              Cancel
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {cancelDisabledReason ? (
            <p>{cancelDisabledReason}</p>
          ) : (
            <p>Cancel the workflow run</p>
          )}
        </TooltipContent>
      </Tooltip>

      {/* More Actions Menu */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {/* Re-enqueue - always shown */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                onClick={handleReenqueue}
                disabled={loading || eventsLoading || reenqueuing}
              >
                <Zap className="h-4 w-4 mr-2" />
                {reenqueuing ? 'Re-enqueuing...' : 'Re-enqueue'}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <ReenqueueTooltipContent />
            </TooltipContent>
          </Tooltip>

          {/* Cancel Active Sleeps - disabled if no active sleeps */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                onClick={handleWakeUp}
                disabled={
                  loading || eventsLoading || !hasPendingSleeps || wakingUp
                }
              >
                <AlarmClockOff className="h-4 w-4 mr-2" />
                {wakingUp ? 'Cancelling sleeps...' : 'Cancel Active Sleeps'}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <CancelSleepsTooltipContent hasPendingSleeps={hasPendingSleeps} />
            </TooltipContent>
          </Tooltip>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// ============================================================================
// Hook for lazy loading events (alternative approach)
// ============================================================================

export function useLazyEvents(
  fetchEvents: () => Promise<Event[]>,
  enabled: boolean
) {
  const [events, setEvents] = useState<Event[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    if (!enabled || hasFetched) return;

    let cancelled = false;
    setLoading(true);

    fetchEvents()
      .then((result) => {
        if (!cancelled) {
          setEvents(result);
          setHasFetched(true);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch events:', err);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, hasFetched, fetchEvents]);

  return { events, loading };
}
