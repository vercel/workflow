'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  type Hook,
  isTerminalWorkflowRunStatus,
} from '@workflow/world';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../lib/toast';
import { HookResolveModalWrapper, useHookActions } from '../hook-actions';
import { Button } from '../ui/button';
import {
  DecryptClickContext,
  type DecryptClickContextValue,
} from '../ui/data-inspector';
import { Spinner } from '../ui/spinner';
import { AttributePanel } from './attribute-panel';
import { EventsList } from './events-list';
import { useSidebarData } from './sidebar-data-context';
import { getSpanEntityName } from './span-name';
import { useSelectedSpanDetail } from './use-selected-span-detail';

// Type guard for runtime validation of span attribute data
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
  /**
   * Events every replay reads past as repeats, computed from the whole log.
   * `rawEvents` is one entity's slice, which cannot answer that on its own.
   */
  duplicateEventIds?: ReadonlySet<string>;
}

/**
 * The selected span's details: pending actions (wake a sleep, resolve a
 * hook), its attributes and its events. Everything but the selection comes
 * from `SidebarDataContext`. It renders no scroll container of its own: the
 * surrounding `DetailPanelShell` body scrolls.
 */
export function EntityDetailPanel({
  selectedSpan,
}: {
  /** Info about the currently selected span from the trace viewer */
  selectedSpan: SelectedSpanInfo | null;
}): React.JSX.Element | null {
  const {
    run,
    onStreamClick,
    onRunClick,
    fetchSpanDetail,
    onWakeUpSleep,
    onLoadEventData,
    onResolveHook,
    encryptionKey,
    onDecrypt,
    isDecrypting = false,
    isDecryptDisabled = false,
    decryptDisabledReason,
    hasEncryptedData: runHasEncryptedData,
    showSeparateEventOccurrenceTimestamps = false,
    getModuleSourceUrl,
  } = useSidebarData();
  const toast = useToast();
  const [stoppingSleep, setStoppingSleep] = useState(false);
  // Track hooks that were resolved in this session so the button hides
  // immediately without waiting for the next event poll.
  const [resolvedHookIds, setResolvedHookIds] = useState<Set<string>>(
    new Set()
  );

  const hasEncryptedData = Boolean(runHasEncryptedData && !encryptionKey);
  const decryptContext = useMemo<DecryptClickContextValue | undefined>(
    () =>
      onDecrypt
        ? {
            onDecrypt,
            isDecrypting,
            isDecryptDisabled,
            decryptDisabledReason,
            hasEncryptedData,
          }
        : undefined,
    [
      onDecrypt,
      isDecrypting,
      isDecryptDisabled,
      decryptDisabledReason,
      hasEncryptedData,
    ]
  );

  const data = selectedSpan?.data;
  const rawEvents = selectedSpan?.rawEvents;
  const rawEventsLength = rawEvents?.length ?? 0;

  const {
    status,
    resource,
    resourceId,
    displayData,
    detail: matchedSpanDetailData,
    error,
  } = useSelectedSpanDetail(selectedSpan, fetchSpanDetail);
  const loading = status === 'loading';

  // Check if this sleep is still pending and can be woken up
  const canWakeUp = useMemo(() => {
    void rawEventsLength;
    if (resource !== 'sleep' || !rawEvents) return false;
    if (isTerminalWorkflowRunStatus(run.status)) return false;
    const hasWaitCreated = rawEvents.some(
      (e) => e.eventType === 'wait_created'
    );
    if (!hasWaitCreated) return false;
    const hasWaitCompleted = rawEvents.some(
      (e) => e.eventType === 'wait_completed'
    );
    return !hasWaitCompleted;
  }, [resource, rawEvents, rawEventsLength, run.status]);

  // Check if this hook can be resolved
  const canResolveHook = useMemo(() => {
    void rawEventsLength;
    if (resource !== 'hook' || !rawEvents || !resourceId) return false;

    // Check if we already resolved this hook in this session
    if (resolvedHookIds.has(resourceId)) return false;

    if (isTerminalWorkflowRunStatus(run.status)) return false;
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

  // The hook to resolve, carrying the token to resolve it with: prefer the
  // fetched detail, then the span's inline data (rebuilt from hook_created).
  const hookToResolve = useMemo((): Hook | undefined => {
    if (resource !== 'hook' || !resourceId) return undefined;
    const detailHook = isHook(matchedSpanDetailData)
      ? matchedSpanDetailData
      : undefined;
    const inlineHook = isHook(data) ? data : undefined;
    const token = detailHook?.token || inlineHook?.token;
    const hook = detailHook ?? inlineHook;
    return hook && token ? { ...hook, token } : undefined;
  }, [resource, resourceId, matchedSpanDetailData, data]);

  const resolveHook = useCallback(
    async (hook: Hook, payload: unknown) => {
      if (!onResolveHook) return;
      await onResolveHook(hook.token, payload, hook);
      // Mark this hook as resolved locally so the button hides immediately
      setResolvedHookIds((prev) => new Set(prev).add(hook.hookId));
    },
    [onResolveHook]
  );
  const hookActions = useHookActions({ onResolve: resolveHook });

  const openResolveHookModal = () => {
    if (!onResolveHook) {
      toast.error('Unable to resolve hook', {
        description: 'No resolve handler provided.',
      });
      return;
    }
    if (!hookToResolve) {
      toast.error('Unable to resolve hook', {
        description:
          'Missing hook token. Try refreshing the run data and retry.',
      });
      return;
    }
    hookActions.openResolveModal(hookToResolve);
  };

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

  const moduleSpecifier =
    getSpanEntityName(displayData) ??
    (typeof run.workflowName === 'string' ? run.workflowName : undefined);

  const moduleSourceUrl = useMemo(() => {
    if (!getModuleSourceUrl || !moduleSpecifier) return undefined;
    const parsed =
      parseStepName(moduleSpecifier) ?? parseWorkflowName(moduleSpecifier);
    if (!parsed) return undefined;
    const dataDeploymentId = displayData.deploymentId;
    return getModuleSourceUrl({
      moduleSpecifier: parsed.moduleSpecifier,
      deploymentId:
        typeof dataDeploymentId === 'string'
          ? dataDeploymentId
          : run.deploymentId,
    });
  }, [getModuleSourceUrl, moduleSpecifier, displayData, run.deploymentId]);

  if (!selectedSpan || !resource || !resourceId) {
    return null;
  }

  const hasPendingActions =
    (resource === 'sleep' && canWakeUp) ||
    (resource === 'hook' && canResolveHook);

  return (
    <>
      <DecryptClickContext.Provider value={decryptContext}>
        <div className="px-4 pb-8">
          {hasPendingActions && (
            <div className="mb-4 flex flex-col gap-2">
              {/* Wake up button for pending sleep calls */}
              {resource === 'sleep' && canWakeUp && (
                <Button
                  variant="secondary"
                  size="small"
                  className="w-full"
                  onClick={handleWakeUp}
                  disabled={stoppingSleep}
                  aria-busy={stoppingSleep}
                >
                  {stoppingSleep ? <Spinner size={16} /> : null}
                  Wake Up Sleep
                </Button>
              )}

              {/* Resolve hook button for pending hooks */}
              {resource === 'hook' && canResolveHook && (
                <Button
                  variant="secondary"
                  size="small"
                  className="w-full"
                  onClick={openResolveHookModal}
                  disabled={hookActions.isResolving}
                  aria-busy={hookActions.isResolving}
                >
                  {hookActions.isResolving ? <Spinner size={16} /> : null}
                  Resolve Hook
                </Button>
              )}
            </div>
          )}

          <AttributePanel
            data={displayData}
            moduleSpecifier={moduleSpecifier}
            moduleSourceUrl={moduleSourceUrl}
            expiredAt={run.expiredAt}
            isLoading={loading}
            error={error ?? undefined}
            onStreamClick={onStreamClick}
            onRunClick={onRunClick}
            resource={resource}
          />

          {rawEvents && (
            <EventsList
              events={rawEvents}
              onLoadEventData={onLoadEventData}
              onStreamClick={onStreamClick}
              onRunClick={onRunClick}
              encryptionKey={encryptionKey}
              showSeparateEventOccurrenceTimestamps={
                showSeparateEventOccurrenceTimestamps
              }
              duplicateEventIds={selectedSpan?.duplicateEventIds}
            />
          )}
        </div>
      </DecryptClickContext.Provider>

      <HookResolveModalWrapper hookActions={hookActions} />
    </>
  );
}
