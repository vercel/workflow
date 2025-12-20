'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import clsx from 'clsx';
import { Send, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  resumeHook,
  useWorkflowResourceData,
  wakeUpRun,
} from '../api/workflow-api-client';
import type { EnvMap } from '../api/workflow-server-actions';
import { EventsList } from '../sidebar/events-list';
import { useTraceViewer } from '../trace-viewer';
import { AttributePanel } from './attribute-panel';
import { ResolveHookModal } from './resolve-hook-modal';

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
  const [showResolveHookModal, setShowResolveHookModal] = useState(false);
  const [resolvingHook, setResolvingHook] = useState(false);

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

  // Check if this sleep is still pending and can be woken up
  // Requirements: no wait_completed event, resumeAt is in the future, run is not terminal
  const spanEvents = selected?.span.events;
  const spanEventsLength = spanEvents?.length ?? 0;
  const canWakeUp = useMemo(() => {
    void spanEventsLength; // Force dependency on length for reactivity
    if (resource !== 'sleep' || !spanEvents) return false;

    // Check run is not in a terminal state
    const terminalStates = ['completed', 'failed', 'cancelled'];
    if (terminalStates.includes(run.status)) return false;

    // Check if wait has already completed
    const hasWaitCompleted = spanEvents.some(
      (e) => e.name === 'wait_completed'
    );
    if (hasWaitCompleted) return false;

    // Check if resumeAt is in the future
    const waitCreatedEvent = spanEvents.find((e) => e.name === 'wait_created');
    const eventData = waitCreatedEvent?.attributes?.eventData as
      | { resumeAt?: string | Date }
      | undefined;
    const resumeAt = eventData?.resumeAt;
    if (!resumeAt) return false;

    const resumeAtDate = new Date(resumeAt);
    return resumeAtDate.getTime() > Date.now();
  }, [resource, spanEvents, spanEventsLength, run.status]);

  // Check if this hook can be resolved (not yet resolved, run is not terminal)
  const canResolveHook = useMemo(() => {
    void spanEventsLength; // Force dependency on length for reactivity
    if (resource !== 'hook' || !spanEvents) return false;

    // Check run is not in a terminal state
    const terminalStates = ['completed', 'failed', 'cancelled'];
    if (terminalStates.includes(run.status)) return false;

    // Check if hook has already been disposed
    const hasHookDisposed = spanEvents.some((e) => e.name === 'hook_disposed');
    if (hasHookDisposed) return false;

    // Hook can be resolved
    return true;
  }, [resource, spanEvents, spanEventsLength, run.status]);

  // Get the hook token for resolving
  const hookToken = useMemo(() => {
    if (resource !== 'hook') return undefined;
    const hook = data as Hook;
    return hook?.token;
  }, [resource, data]);

  // Fetch full resource data with events
  const {
    data: fetchedData,
    error,
    loading,
  } = useWorkflowResourceData(
    env,
    resource as 'run' | 'step' | 'hook' | 'sleep',
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

  const handleResolveHook = useCallback(
    async (payload: unknown) => {
      if (resolvingHook || !hookToken) return;

      try {
        setResolvingHook(true);
        await resumeHook(env, hookToken, payload);
        toast.success('Hook resolved', {
          description: 'The payload has been sent and the hook resolved.',
        });
        setShowResolveHookModal(false);
      } catch (err) {
        console.error('Failed to resolve hook:', err);
        toast.error('Failed to resolve hook', {
          description:
            err instanceof Error ? err.message : 'An unknown error occurred',
        });
      } finally {
        setResolvingHook(false);
      }
    },
    [env, hookToken, resolvingHook]
  );

  if (!selected || !resource || !resourceId) {
    return null;
  }

  const displayData = fetchedData || data;

  return (
    <div className={clsx('flex flex-col px-2')}>
      {/* Wake up button for pending sleep calls */}
      {resource === 'sleep' && canWakeUp && (
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

      {/* Resolve hook button for pending hooks */}
      {resource === 'hook' && canResolveHook && (
        <div className="mb-3 pb-3 border-b border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setShowResolveHookModal(true)}
            disabled={resolvingHook}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md w-full',
              'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200',
              'hover:bg-blue-200 dark:hover:bg-blue-900/50',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
              resolvingHook ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
            )}
          >
            <Send className="h-4 w-4" />
            Resolve Hook
          </button>
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
            Send a JSON payload to resolve this hook.
          </p>
        </div>
      )}

      {/* Resolve Hook Modal */}
      <ResolveHookModal
        isOpen={showResolveHookModal}
        onClose={() => setShowResolveHookModal(false)}
        onSubmit={handleResolveHook}
        isSubmitting={resolvingHook}
      />

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
