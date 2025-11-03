'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import clsx from 'clsx';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useWorkflowResourceData } from '../api/workflow-api-client';
import type { EnvMap } from '../api/workflow-server-actions';
import { EventsList } from '../sidebar/events-list';
import { useTraceViewer } from '../trace-viewer';
import { AttributePanel } from './attribute-panel';

/**
 * Custom panel component for workflow traces that displays entity details
 */
export function WorkflowDetailPanel({
  env,
}: {
  env: EnvMap;
}): React.JSX.Element | null {
  const { state } = useTraceViewer();
  const { selected } = state;

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

  if (!selected || !resource || !resourceId) {
    return null;
  }

  const displayData = fetchedData || data;

  return (
    <div className={clsx('flex flex-col px-2')}>
      {/* Content display */}
      <AttributePanel
        data={displayData}
        isLoading={loading}
        error={error ?? undefined}
      />
      {resource !== 'run' && (
        <EventsList
          correlationId={resourceId}
          env={env}
          events={selected.span.events}
        />
      )}
    </div>
  );
}
