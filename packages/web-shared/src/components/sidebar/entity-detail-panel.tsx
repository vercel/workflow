'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import clsx from 'clsx';
import { Send, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTraceViewer } from '../trace-viewer';
import { AttributePanel } from './attribute-panel';
import { EventsList } from './events-list';
import { ResolveHookModal } from './resolve-hook-modal';

// Type guards for runtime validation of span attribute data
function isStep(data: unknown): data is Step {
  return data !== null && typeof data === 'object' && 'stepId' in data;
}

function isWorkflowRun(data: unknown): data is WorkflowRun {
  return data !== null && typeof data === 'object' && 'runId' in data;
}

function isHook(data: unknown): data is Hook {
  return data !== null && typeof data === 'object' && 'hookId' in data;
}

/**
 * Info about the currently selected span
 */
export type SpanSelectionInfo = {
  resource: 'run' | 'step' | 'hook' | 'sleep';
  resourceId: string;
  runId?: string;
};

/**
 * Custom panel component for workflow traces that displays entity details
 */
export function EntityDetailPanel({
  run,
  onStreamClick,
  spanDetailData,
  spanDetailError,
  spanDetailLoading,
  onSpanSelect,
  onWakeUpSleep,
  onResolveHook,
}: {
  run: WorkflowRun;
  /** Callback when a stream reference is clicked */
  onStreamClick?: (streamId: string) => void;
  /** Pre-fetched span detail data for the selected span. */
  spanDetailData: WorkflowRun | Step | Hook | Event | null;
  /** Error from external span detail fetch. */
  spanDetailError?: Error | null;
  /** Loading state from external span detail fetch. */
  spanDetailLoading?: boolean;
  /** Callback when a span is selected. Use this to fetch data externally and pass via spanDetailData. */
  onSpanSelect: (info: SpanSelectionInfo) => void;
  /** Callback to wake up a pending sleep call. */
  onWakeUpSleep?: (
    runId: string,
    correlationId: string
  ) => Promise<{ stoppedCount: number }>;
  /** Callback to resolve a hook with a payload. */
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
}): React.JSX.Element | null {
  const { state } = useTraceViewer();
  const { selected } = state;
  const [stoppingSleep, setStoppingSleep] = useState(false);
  const [showResolveHookModal, setShowResolveHookModal] = useState(false);
  const [resolvingHook, setResolvingHook] = useState(false);

  const data = selected?.span.attributes?.data;

  // Stable ref for onSpanSelect to avoid re-render loops when parent
  // doesn't memoize the callback with useCallback.
  const onSpanSelectRef = useRef(onSpanSelect);
  useEffect(() => {
    onSpanSelectRef.current = onSpanSelect;
  });

  // Determine resource ID and runId (needed for steps)
  // Uses type guards to validate the data shape matches the expected resource type
  const { resource, resourceId, runId } = useMemo(() => {
    const resource = selected?.span.attributes?.resource;
    if (resource === 'step' && isStep(data)) {
      return { resource: 'step', resourceId: data.stepId, runId: data.runId };
    } else if (resource === 'run' && isWorkflowRun(data)) {
      return { resource: 'run', resourceId: data.runId, runId: undefined };
    } else if (resource === 'hook' && isHook(data)) {
      return { resource: 'hook', resourceId: data.hookId, runId: undefined };
    } else if (resource === 'sleep') {
      return {
        resource: 'sleep',
        resourceId: selected?.span?.spanId,
        runId: undefined,
      };
    }
    return { resource: undefined, resourceId: undefined, runId: undefined };
  }, [selected, data]);

  // Notify parent when span selection changes
  useEffect(() => {
    if (
      resource &&
      resourceId &&
      ['run', 'step', 'hook', 'sleep'].includes(resource)
    ) {
      onSpanSelectRef.current({
        resource: resource as 'run' | 'step' | 'hook' | 'sleep',
        resourceId,
        runId,
      });
    }
  }, [resource, resourceId, runId]);

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

  const error = spanDetailError ?? undefined;
  const loading = spanDetailLoading ?? false;

  // Get the hook token for resolving (prefer fetched data when available)
  const hookToken = useMemo(() => {
    if (resource !== 'hook') return undefined;
    const candidate = spanDetailData ?? data;
    return isHook(candidate) ? candidate.token : undefined;
  }, [resource, spanDetailData, data]);

  useEffect(() => {
    if (error && selected && resource) {
      toast.error(`Failed to load ${resource} details`, {
        description: error.message,
      });
    }
  }, [error, resource, selected]);

  const handleWakeUp = async () => {
    if (stoppingSleep || !resourceId) return;
    if (!onWakeUpSleep) {
      toast.error('Unable to wake up sleep', {
        description: 'No wake-up handler provided.',
      });
      return;
    }

    try {
      setStoppingSleep(true);
      const result = await onWakeUpSleep(run.runId, resourceId);
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
      if (resolvingHook) return;
      if (!onResolveHook) {
        toast.error('Unable to resolve hook', {
          description: 'No resolve handler provided.',
        });
        return;
      }
      if (!hookToken) {
        toast.error('Unable to resolve hook', {
          description:
            'Missing hook token. Try refreshing the run data and retry.',
        });
        return;
      }

      try {
        setResolvingHook(true);
        const candidate = spanDetailData ?? data;
        const hook = isHook(candidate) ? candidate : undefined;
        await onResolveHook(hookToken, payload, hook);
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
    [onResolveHook, hookToken, resolvingHook, spanDetailData, data]
  );

  if (!selected || !resource || !resourceId) {
    return null;
  }

  const displayData = (spanDetailData ?? data) as
    | WorkflowRun
    | Step
    | Hook
    | Event;

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
              'bg-primary text-primary-foreground hover:bg-primary/90',
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
      {resource !== 'run' && <EventsList events={selected.span.events} />}
    </div>
  );
}
