'use client';

import {
  cancelRun,
  type EnvMap,
  type Event,
  recreateRun,
  stopSleepRun,
  wakeUpRun,
} from '@workflow/web-shared';
import type { WorkflowRunStatus } from '@workflow/world';
import { AlarmClockOff, Loader2, RotateCw, XCircle, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from './ui/button';

/**
 * Compute whether there are pending sleeps from an events list
 */
export function hasPendingSleepsFromEvents(
  events: Event[] | undefined
): boolean {
  if (!events || events.length === 0) return false;
  const waitCreatedCorrelationIds = new Set(
    events
      .filter((e) => e.eventType === 'wait_created')
      .map((e) => e.correlationId)
  );
  const waitCompletedCorrelationIds = new Set(
    events
      .filter((e) => e.eventType === 'wait_completed')
      .map((e) => e.correlationId)
  );
  for (const correlationId of waitCreatedCorrelationIds) {
    if (!waitCompletedCorrelationIds.has(correlationId)) {
      return true;
    }
  }
  return false;
}

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
  const [rerunning, setRerunning] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [stoppingSleep, setStoppingSleep] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const hasPendingSleeps = useMemo(
    () => hasPendingSleepsFromEvents(events),
    [events]
  );

  const handleReplay = async (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    if (rerunning) return;

    try {
      setRerunning(true);
      const newRunId = await recreateRun(env, runId);
      toast.success('New run started', {
        description: `Run ID: ${newRunId}`,
      });
      callbacks?.onSuccess?.();
      callbacks?.onNavigateToRun?.(newRunId);
    } catch (err) {
      toast.error('Failed to re-run', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setRerunning(false);
    }
  };

  const handleWakeUp = async (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    if (wakingUp) return;

    try {
      setWakingUp(true);
      await wakeUpRun(env, runId);
      toast.success('Run woken up', {
        description: 'The workflow orchestration layer has been re-enqueued.',
      });
      callbacks?.onSuccess?.();
    } catch (err) {
      toast.error('Failed to wake up', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setWakingUp(false);
    }
  };

  const handleStopSleep = async (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    if (stoppingSleep) return;

    try {
      setStoppingSleep(true);
      const result = await stopSleepRun(env, runId);
      if (result.stoppedCount > 0) {
        toast.success('Sleep interrupted', {
          description: `Stopped ${result.stoppedCount} pending sleep${result.stoppedCount > 1 ? 's' : ''} and woke up the run.`,
        });
      } else {
        toast.info('No pending sleeps', {
          description: 'There were no pending sleep calls to interrupt.',
        });
      }
      callbacks?.onSuccess?.();
    } catch (err) {
      toast.error('Failed to stop sleep', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setStoppingSleep(false);
    }
  };

  const handleCancel = async (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    if (cancelling) return;

    if (runStatus !== 'pending') {
      toast.error('Cannot cancel', {
        description: 'Only pending runs can be cancelled',
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
  };

  return (
    <>
      <DropdownMenuItem onClick={handleReplay} disabled={rerunning}>
        <RotateCw className="h-4 w-4 mr-2" />
        {rerunning ? 'Replaying...' : 'Replay Run'}
      </DropdownMenuItem>

      {eventsLoading ? (
        <DropdownMenuItem disabled>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Loading...
        </DropdownMenuItem>
      ) : hasPendingSleeps ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem
              onClick={handleStopSleep}
              disabled={stoppingSleep}
            >
              <AlarmClockOff className="h-4 w-4 mr-2" />
              {stoppingSleep ? 'Stopping...' : 'Stop sleep'}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            Interrupt any current calls to <code>sleep()</code> and wake up the
            run.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem onClick={handleWakeUp} disabled={wakingUp}>
              <Zap className="h-4 w-4 mr-2" />
              {wakingUp ? 'Waking up...' : 'Wake up'}
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            Re-enqueue the workflow orchestration layer. This is a no-op, unless
            the workflow got stuck due to an implementation issue in the World.
            This is useful for debugging custom Worlds.
          </TooltipContent>
        </Tooltip>
      )}

      <DropdownMenuItem
        onClick={handleCancel}
        disabled={runStatus !== 'pending' || cancelling}
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
  const [wakingUp, setWakingUp] = useState(false);
  const [stoppingSleep, setStoppingSleep] = useState(false);

  const hasPendingSleeps = useMemo(
    () => hasPendingSleepsFromEvents(events),
    [events]
  );

  const isRunActive = runStatus === 'pending' || runStatus === 'running';
  const canCancel = isRunActive;

  const handleWakeUp = async () => {
    if (wakingUp) return;

    try {
      setWakingUp(true);
      await wakeUpRun(env, runId);
      toast.success('Run woken up', {
        description: 'The workflow orchestration layer has been re-enqueued.',
      });
      callbacks?.onSuccess?.();
    } catch (err) {
      console.error('Failed to wake up run:', err);
      toast.error('Failed to wake up run', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setWakingUp(false);
    }
  };

  const handleStopSleep = async () => {
    if (stoppingSleep) return;

    try {
      setStoppingSleep(true);
      const result = await stopSleepRun(env, runId);
      if (result.stoppedCount > 0) {
        toast.success('Sleep interrupted', {
          description: `Stopped ${result.stoppedCount} pending sleep${result.stoppedCount > 1 ? 's' : ''} and woke up the run.`,
        });
      } else {
        toast.info('No pending sleeps', {
          description: 'There were no pending sleep() calls to interrupt.',
        });
      }
      callbacks?.onSuccess?.();
    } catch (err) {
      console.error('Failed to stop sleep:', err);
      toast.error('Failed to stop sleep', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setStoppingSleep(false);
    }
  };

  // Rerun button logic
  const canRerun = !loading && !isRunActive;
  const rerunDisabledReason = loading
    ? 'Loading run data...'
    : isRunActive
      ? 'Cannot re-run while workflow is still running'
      : '';

  // Wake up button logic
  const canWakeUp = !loading && !wakingUp;
  const wakeUpDisabledReason = wakingUp
    ? 'Waking up workflow...'
    : loading
      ? 'Loading run data...'
      : '';

  // Stop sleep button logic
  const canStopSleep = !loading && !stoppingSleep && hasPendingSleeps;
  const stopSleepDisabledReason = stoppingSleep
    ? 'Stopping sleep...'
    : loading
      ? 'Loading run data...'
      : !hasPendingSleeps
        ? 'No pending sleep() calls to interrupt'
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

      {/* Wake up / Stop sleep Button */}
      {eventsLoading ? (
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
        </Button>
      ) : hasPendingSleeps ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleStopSleep}
                disabled={!canStopSleep || stoppingSleep}
              >
                <AlarmClockOff className="h-4 w-4" />
                {stoppingSleep ? 'Stopping...' : 'Stop sleep'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {stopSleepDisabledReason ? (
              <p>{stopSleepDisabledReason}</p>
            ) : (
              <p>
                Interrupt any current calls to <code>sleep()</code> and wake up
                the run.
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
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
                Re-enqueue the workflow orchestration layer. This is a no-op,
                unless the workflow got stuck due to an implementation issue in
                the World. This is useful for debugging custom Worlds.
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
// Lazy-loading wrapper for dropdown (fetches events when dropdown opens)
// ============================================================================

interface LazyRunActionsDropdownContentProps
  extends RunActionsDropdownItemsProps {
  fetchEvents: () => Promise<Event[]>;
}

export function LazyRunActionsDropdownContent({
  fetchEvents,
  ...props
}: LazyRunActionsDropdownContentProps) {
  const [events, setEvents] = useState<Event[] | undefined>(undefined);
  const [eventsLoading, setEventsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setEventsLoading(true);

    fetchEvents()
      .then((result) => {
        if (!cancelled) {
          setEvents(result);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch events:', err);
        if (!cancelled) {
          setEvents(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEventsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetchEvents]);

  return (
    <RunActionsDropdownItems
      {...props}
      events={events}
      eventsLoading={eventsLoading}
    />
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
