'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import clsx from 'clsx';
import { Send, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
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
 * Info about the selected span from the trace viewer.
 */
export interface SelectedSpanInfo {
  /** The raw data from the span attributes (step/run/hook object from the trace) */
  data?: unknown;
  /** The span resource type (from span attributes) */
  resource?: string;
  /** The span ID (correlationId for filtering events) */
  spanId?: string;
  /** Raw correlated events from the store (NOT from the trace worker pipeline) */
  rawEvents?: Event[];
}

/**
 * Panel component for workflow traces that displays entity details.
 *
 * This component is rendered OUTSIDE the trace viewer context — it
 * receives all data via props rather than reading from context.
 */
export function EntityDetailPanel({
  run,
  hooks,
  onStreamClick,
  spanDetailData,
  spanDetailError,
  spanDetailLoading,
  onSpanSelect,
  onWakeUpSleep,
  onLoadEventData,
  onResolveHook,
  selectedSpan,
}: {
  run: WorkflowRun;
  /** All hooks for the current run (used as fallback for token lookup). */
  hooks?: Hook[];
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
  /** Callback to load event data for a specific event (lazy loading) */
  onLoadEventData?: (
    correlationId: string,
    eventId: string
  ) => Promise<unknown | null>;
  /** Callback to resolve a hook with a payload. */
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
  /** Info about the currently selected span from the trace viewer */
  selectedSpan: SelectedSpanInfo | null;
}): React.JSX.Element | null {
  const [stoppingSleep, setStoppingSleep] = useState(false);
  const [showResolveHookModal, setShowResolveHookModal] = useState(false);
  const [resolvingHook, setResolvingHook] = useState(false);
  // Track hooks that were resolved in this session so the button hides
  // immediately without waiting for the next event poll.
  const [resolvedHookIds, setResolvedHookIds] = useState<Set<string>>(
    new Set()
  );

  const data = selectedSpan?.data;
  const rawEvents = selectedSpan?.rawEvents;
  const rawEventsLength = rawEvents?.length ?? 0;

  // Determine resource type, ID, and runId from the selected span
  const { resource, resourceId, runId } = useMemo(() => {
    if (!selectedSpan) {
      return { resource: undefined, resourceId: undefined, runId: undefined };
    }

    const res = selectedSpan.resource;
    if (res === 'step' && isStep(data)) {
      return { resource: 'step', resourceId: data.stepId, runId: data.runId };
    }
    if (res === 'run' && isWorkflowRun(data)) {
      return { resource: 'run', resourceId: data.runId, runId: undefined };
    }
    if (res === 'hook' && isHook(data)) {
      return { resource: 'hook', resourceId: data.hookId, runId: undefined };
    }
    if (res === 'sleep') {
      return {
        resource: 'sleep',
        resourceId: selectedSpan.spanId,
        runId: undefined,
      };
    }
    return { resource: undefined, resourceId: undefined, runId: undefined };
  }, [selectedSpan, data]);

  // Notify parent when span selection changes
  useEffect(() => {
    if (
      resource &&
      resourceId &&
      ['run', 'step', 'hook', 'sleep'].includes(resource)
    ) {
      onSpanSelect({
        resource: resource as 'run' | 'step' | 'hook' | 'sleep',
        resourceId,
        runId,
      });
    }
  }, [resource, resourceId, runId, onSpanSelect]);

  // Check if this sleep is still pending and can be woken up
  const canWakeUp = useMemo(() => {
    void rawEventsLength;
    if (resource !== 'sleep' || !rawEvents) return false;
    const terminalStates = ['completed', 'failed', 'cancelled'];
    if (terminalStates.includes(run.status)) return false;
    const hasWaitCompleted = rawEvents.some(
      (e) => e.eventType === 'wait_completed'
    );
    if (hasWaitCompleted) return false;
    const waitCreatedEvent = rawEvents.find(
      (e) => e.eventType === 'wait_created'
    );
    const eventData = (waitCreatedEvent as any)?.eventData as
      | { resumeAt?: string | Date }
      | undefined;
    const resumeAt = eventData?.resumeAt;
    if (!resumeAt) return false;
    const resumeAtDate = new Date(resumeAt);
    return resumeAtDate.getTime() > Date.now();
  }, [resource, rawEvents, rawEventsLength, run.status]);

  // Check if this hook can be resolved
  const canResolveHook = useMemo(() => {
    void rawEventsLength;
    if (resource !== 'hook' || !rawEvents || !resourceId) return false;

    // Check if we already resolved this hook in this session
    if (resolvedHookIds.has(resourceId)) return false;

    const terminalStates = ['completed', 'failed', 'cancelled'];
    if (terminalStates.includes(run.status)) return false;
    const hasHookDisposed = rawEvents.some(
      (e) => e.eventType === 'hook_disposed'
    );
    if (hasHookDisposed) return false;
    return true;
  }, [
    resource,
    resourceId,
    rawEvents,
    rawEventsLength,
    run.status,
    resolvedHookIds,
  ]);

  const error = spanDetailError ?? undefined;
  const loading = spanDetailLoading ?? false;

  // Get the hook token for resolving (prefer fetched data, then hooks array fallback)
  const hookToken = useMemo(() => {
    if (resource !== 'hook' || !resourceId) return undefined;
    // 1. Try the externally-fetched detail data first
    if (isHook(spanDetailData) && spanDetailData.token) {
      return spanDetailData.token;
    }
    // 2. Try the hooks array (always has tokens)
    const hookFromArray = hooks?.find((h) => h.hookId === resourceId);
    if (hookFromArray?.token) {
      return hookFromArray.token;
    }
    // 3. Try the span's inline data (partial hook from events - may lack token)
    if (isHook(data) && (data as Hook).token) {
      return (data as Hook).token;
    }
    return undefined;
  }, [resource, resourceId, spanDetailData, data, hooks]);

  useEffect(() => {
    if (error && selectedSpan && resource) {
      toast.error(`Failed to load ${resource} details`, {
        description: error.message,
      });
    }
  }, [error, resource, selectedSpan]);

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
        // Mark this hook as resolved locally so the button hides immediately
        if (resourceId) {
          setResolvedHookIds((prev) => new Set(prev).add(resourceId));
        }
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

  if (!selectedSpan || !resource || !resourceId) {
    return null;
  }

  // For sleep spans, spanDetailData from the host is typically an events array
  // (not a single entity), so always prefer the inline wait entity from span
  // attributes which contains waitId, runId, createdAt, resumeAt, completedAt.
  const displayData = (
    resource === 'sleep' ? data : (spanDetailData ?? data)
  ) as WorkflowRun | Step | Hook | Event;

  return (
    <div
      className={clsx('flex flex-col px-3')}
      style={{ paddingTop: 12, gap: 16 }}
    >
      {/* Wake up button for pending sleep calls */}
      {resource === 'sleep' && canWakeUp && (
        <div
          className="mb-3 pb-3"
          style={{ borderBottom: '1px solid var(--ds-gray-alpha-400)' }}
        >
          <button
            type="button"
            onClick={handleWakeUp}
            disabled={stoppingSleep}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md w-full',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
              stoppingSleep ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
            )}
            style={{
              background: 'var(--ds-amber-200)',
              color: 'var(--ds-amber-900)',
            }}
          >
            <Zap className="h-4 w-4" />
            {stoppingSleep ? 'Waking up...' : 'Wake up'}
          </button>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--ds-gray-900)' }}>
            Interrupt this sleep call and wake up the run.
          </p>
        </div>
      )}

      {/* Resolve hook button for pending hooks */}
      {resource === 'hook' && canResolveHook && (
        <div
          className="mb-3 pb-3"
          style={{ borderBottom: '1px solid var(--ds-gray-alpha-400)' }}
        >
          <button
            type="button"
            onClick={() => setShowResolveHookModal(true)}
            disabled={resolvingHook}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md w-full',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
              resolvingHook ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
            )}
            style={{
              background: 'var(--ds-gray-1000)',
              color: 'var(--ds-background-100)',
            }}
          >
            <Send className="h-4 w-4" />
            Resolve Hook
          </button>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--ds-gray-900)' }}>
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
      {resource !== 'run' && rawEvents && (
        <EventsList events={rawEvents} onLoadEventData={onLoadEventData} />
      )}
    </div>
  );
}
