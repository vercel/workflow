'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import clsx from 'clsx';
import { Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useWorkflowResourceData, wakeUpRun } from '../api/workflow-api-client';
import type { EnvMap } from '../api/workflow-server-actions';
import { EventsList } from '../sidebar/events-list';
import { useTraceViewer } from '../trace-viewer';
import { AttributePanel } from './attribute-panel';

/**
 * Custom panel component for workflow traces that displays entity details
 */
export function WorkflowDetailPanel({
  env,
  run,
  onStreamClick,
}: {
  env: EnvMap;
  run: WorkflowRun;
  /** Callback when a stream reference is clicked */
  onStreamClick?: (streamId: string) => void;
}): React.JSX.Element | null {
  const { state } = useTraceViewer();
  const { selected } = state;
  const [stoppingSleep, setStoppingSleep] = useState(false);

  const data = selected?.span.attributes?.data as
    | Step
    | WorkflowRun
    | Hook
    | Event;

  // Determine resource ID and runId (needed for steps)
  const { resource, resourceId, runId } = useMemo(() => {
    const resource = selected?.span.attributes?.resource;
    if (resource === 'step') {
      const step = data as Step;
      return { resource: 'step', resourceId: step.stepId, runId: step.runId };
    } else if (resource === 'run') {
      const run = data as WorkflowRun;
      return { resource: 'run', resourceId: run.runId, runId: undefined };
    } else if (resource === 'hook') {
      const hook = data as Hook;
      return { resource: 'hook', resourceId: hook.hookId, runId: undefined };
    } else if (resource === 'sleep') {
      return {
        resource: 'sleep',
        resourceId: selected?.span?.spanId,
        runId: undefined,
      };
    }
    return { resource: undefined, resourceId: undefined, runId: undefined };
  }, [selected, data]);

  // Check if this sleep is still pending (no wait_completed event)
  // We include events length to ensure recomputation when new events are added
  // (the array reference might not change when events are pushed to it)
  const spanEvents = selected?.span.events;
  const spanEventsLength = spanEvents?.length ?? 0;
  const isSleepPending = useMemo(() => {
    void spanEventsLength; // Force dependency on length for reactivity
    if (resource !== 'sleep' || !spanEvents) return false;
    const hasWaitCompleted = spanEvents.some(
      (e) => e.name === 'wait_completed'
    );
    return !hasWaitCompleted;
  }, [resource, spanEvents, spanEventsLength]);

  // Fetch full resource data with events
  const {
    data: fetchedData,
    error,
    loading,
  } = useWorkflowResourceData(
    env,
    resource as 'run' | 'step' | 'hook',
    resourceId ?? '',
    { runId }
  );

  useEffect(() => {
    if (error && selected && resource) {
      toast.error(`Failed to load ${resource} details`, {
        description: error.message,
      });
    }
  }, [error, resource, selected]);

  const handleWakeUp = async () => {
    if (stoppingSleep || !resourceId) return;

    try {
      setStoppingSleep(true);
      const result = await wakeUpRun(env, run.runId, {
        correlationIds: [resourceId],
      });
      if (result.stoppedCount > 0) {
        toast.success('Run woken up', {
          description:
            'The sleep call has been interrupted and the run woken up.',
        });
      } else {
        toast.info('Sleep already completed', {
          description: 'This sleep call has already finished.',
        });
      }
    } catch (err) {
      console.error('Failed to wake up run:', err);
      toast.error('Failed to wake up run', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setStoppingSleep(false);
    }
  };

  if (!selected || !resource || !resourceId) {
    return null;
  }

  const displayData = fetchedData || data;

  return (
    <div className={clsx('flex flex-col px-2')}>
      {/* Wake up button for pending sleep calls */}
      {resource === 'sleep' && isSleepPending && (
        <div className="mb-3 pb-3 border-b border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={handleWakeUp}
            disabled={stoppingSleep}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md w-full',
              'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200',
              'hover:bg-amber-200 dark:hover:bg-amber-900/50',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
              stoppingSleep ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
            )}
          >
            <Zap className="h-4 w-4" />
            {stoppingSleep ? 'Waking up...' : 'Wake up'}
          </button>
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
            Interrupt this sleep call and wake up the run.
          </p>
        </div>
      )}

      {/* Content display */}
      <AttributePanel
        data={displayData}
        expiredAt={run.expiredAt}
        isLoading={loading}
        error={error ?? undefined}
        onStreamClick={onStreamClick}
      />
      {resource !== 'run' && (
        <EventsList
          correlationId={resourceId}
          env={env}
          events={selected.span.events}
          expiredAt={run.expiredAt}
        />
      )}
    </div>
  );
}
