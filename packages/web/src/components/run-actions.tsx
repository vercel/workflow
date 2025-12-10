'use client';

import {
  analyzeEvents,
  cancelRun,
  type EnvMap,
  type Event,
  recreateRun,
  reenqueueRun,
  shouldShowReenqueueButton,
  wakeUpRun,
} from '@workflow/web-shared';
import type { WorkflowRunStatus } from '@workflow/world';
import { Loader2, RotateCw, XCircle, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
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

  const showReenqueueForStuckWorkflow = useMemo(
    () => shouldShowReenqueueButton(events, runStatus),
    [events, runStatus]
  );

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
        toast.success('Run woken up', {
          description: `Interrupted ${result.stoppedCount} pending sleep${result.stoppedCount > 1 ? 's' : ''} and woke up the run.`,
        });
      } else {
        toast.info('No pending sleeps', {
          description: 'There were no pending sleep calls to interrupt.',
        });
      }
      callbacks?.onSuccess?.();
    } catch (err) {
      toast.error('Failed to wake up', {
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
    showReenqueueForStuckWorkflow,
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

function WakeUpTooltipContent() {
  return (
    <>
      Interrupt any current calls to <code>sleep</code> and wake up the run.
    </>
  );
}

function ReenqueueTooltipContent({ isStuck }: { isStuck: boolean }) {
  if (isStuck) {
    return (
      <>
        This workflow has no active steps or sleep calls, it maybe be stuck.
        Re-enqueue the workflow orchestration layer to resume execution.
      </>
    );
  }
  return (
    <>
      Re-enqueue the workflow orchestration layer. This is a no-op, unless the
      workflow got stuck due to an implementation issue in the World. This is
      useful for debugging custom Worlds.
    </>
  );
}

// ============================================================================
// Dropdown Menu Items (for runs-table)
// ============================================================================

export interface RunActionsDropdownItemsProps extends RunActionsBaseProps {
  /** Stop click event propagation (useful in table rows) */
  stopPropagation?: boolean;
  /** Show debug actions like Re-enqueue (requires debug=1 URL param) */
  showDebugActions?: boolean;
}

export function RunActionsDropdownItems({
  env,
  runId,
  runStatus,
  events,
  eventsLoading,
  callbacks,
  stopPropagation = false,
  showDebugActions = false,
}: RunActionsDropdownItemsProps) {
  const {
    rerunning,
    reenqueuing,
    wakingUp,
    cancelling,
    hasPendingSleeps,
    showReenqueueForStuckWorkflow,
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

  const onWakeUp = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    handleWakeUp();
  };

  const onCancel = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    handleCancel();
  };

  const isRunActive = runStatus === 'pending' || runStatus === 'running';

  // Determine which button to show: Wake up, Re-enqueue, or disabled Wake up
  const showReenqueue =
    !eventsLoading && (showDebugActions || showReenqueueForStuckWorkflow);

  return (
    <>
      <DropdownMenuItem onClick={onReplay} disabled={rerunning}>
        <RotateCw className="h-4 w-4 mr-2" />
        {rerunning ? 'Replaying...' : 'Replay Run'}
      </DropdownMenuItem>

      {/* Wake up / Re-enqueue button - mutually exclusive */}
      {eventsLoading ? (
        // Loading state: show Wake up button with spinner
        <DropdownMenuItem disabled>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Wake up
        </DropdownMenuItem>
      ) : showReenqueue ? (
        // Re-enqueue: shown when debug flag or stuck workflow detected
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem onClick={onReenqueue} disabled={reenqueuing}>
              <Zap className="h-4 w-4 mr-2" />
              {reenqueuing ? 'Re-enqueuing...' : 'Re-enqueue'}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            <ReenqueueTooltipContent
              isStuck={showReenqueueForStuckWorkflow && !showDebugActions}
            />
          </TooltipContent>
        </Tooltip>
      ) : (
        // Wake up: enabled if pending sleeps, disabled otherwise
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem
              onClick={onWakeUp}
              disabled={!hasPendingSleeps || wakingUp}
            >
              <Zap className="h-4 w-4 mr-2" />
              {wakingUp ? 'Waking up...' : 'Wake up'}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            {hasPendingSleeps ? (
              <WakeUpTooltipContent />
            ) : (
              <>No pending sleep calls to interrupt.</>
            )}
          </TooltipContent>
        </Tooltip>
      )}

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
  /** Show debug actions like Re-enqueue (requires debug=1 URL param) */
  showDebugActions?: boolean;
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
  showDebugActions = false,
}: RunActionsButtonsProps) {
  const {
    reenqueuing,
    wakingUp,
    hasPendingSleeps,
    showReenqueueForStuckWorkflow,
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

  // Re-enqueue button logic
  const canReenqueue = !loading && !reenqueuing;
  const reenqueueDisabledReason = reenqueuing
    ? 'Re-enqueuing workflow...'
    : loading
      ? 'Loading run data...'
      : '';

  // Wake up button logic
  const canWakeUp = !loading && !wakingUp && hasPendingSleeps;
  const wakeUpDisabledReason = wakingUp
    ? 'Waking up workflow...'
    : loading
      ? 'Loading run data...'
      : !hasPendingSleeps
        ? 'No pending sleep calls to interrupt'
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

  // Determine which button to show: Wake up, Re-enqueue, or disabled Wake up
  const showReenqueue =
    !eventsLoading && (showDebugActions || showReenqueueForStuckWorkflow);

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

      {/* Wake up / Re-enqueue Button - mutually exclusive */}
      {eventsLoading ? (
        // Loading state: show Wake up button with spinner
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          Wake up
        </Button>
      ) : showReenqueue ? (
        // Re-enqueue: shown when debug flag or stuck workflow detected
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReenqueue}
                disabled={!canReenqueue || reenqueuing}
              >
                <Zap className="h-4 w-4" />
                {reenqueuing ? 'Re-enqueuing...' : 'Re-enqueue'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {reenqueueDisabledReason ? (
              <p>{reenqueueDisabledReason}</p>
            ) : (
              <p>
                <ReenqueueTooltipContent
                  isStuck={showReenqueueForStuckWorkflow && !showDebugActions}
                />
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        // Wake up: enabled if pending sleeps, disabled otherwise
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleWakeUp}
                disabled={!canWakeUp || wakingUp}
              >
                <Zap className="h-4 w-4" />
                {wakingUp ? 'Waking up...' : 'Wake up'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {wakeUpDisabledReason ? (
              <p>{wakeUpDisabledReason}</p>
            ) : (
              <p>
                <WakeUpTooltipContent />
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      )}

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
