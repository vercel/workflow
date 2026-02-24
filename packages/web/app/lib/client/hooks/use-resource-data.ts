import {
  hydrateResourceIO,
  waitEventsToWaitEntity,
} from '@workflow/web-shared';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useState } from 'react';
import {
  unwrapOrThrow,
  unwrapServerActionResult,
  WorkflowWebAPIError,
} from '~/lib/client/workflow-errors';
import {
  fetchEventsByCorrelationId,
  fetchHook,
  fetchRun,
  fetchStep,
} from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

// Helper function to fetch resource and get correlation ID
async function fetchResourceWithCorrelationId(
  env: EnvMap,
  resource: 'run' | 'step' | 'hook',
  resourceId: string,
  options: {
    runId?: string;
    resolveData?: 'none' | 'all';
  } = {}
): Promise<{
  data: WorkflowRun | Step | Hook;
  correlationId: string;
}> {
  const resolveData = options.resolveData ?? 'all';
  let resourceData: WorkflowRun | Step | Hook;
  let correlationId: string;

  if (resource === 'run') {
    resourceData = await unwrapOrThrow(fetchRun(env, resourceId, resolveData));
    correlationId = (resourceData as WorkflowRun).runId;
  } else if (resource === 'step') {
    const { runId } = options;
    if (!runId) {
      throw new WorkflowWebAPIError('runId is required for step resource', {
        layer: 'client',
      });
    }
    resourceData = await unwrapOrThrow(
      fetchStep(env, runId, resourceId, resolveData)
    );
    correlationId = (resourceData as Step).stepId;
  } else if (resource === 'hook') {
    resourceData = await unwrapOrThrow(fetchHook(env, resourceId, resolveData));
    correlationId = (resourceData as Hook).hookId;
  } else {
    throw new WorkflowWebAPIError(`Unknown resource type: ${resource}`, {
      layer: 'client',
    });
  }

  resourceData = hydrateResourceIO(resourceData);
  return { data: resourceData, correlationId };
}

/**
 * Returns (and keeps up-to-date) data inherent to a specific run/step/hook,
 * resolving input/output/metadata, AND loading all related events with full event data.
 */
export function useWorkflowResourceData(
  env: EnvMap,
  resource: 'run' | 'step' | 'hook' | 'sleep',
  resourceId: string,
  options: {
    refreshInterval?: number;
    runId?: string;
    /** If false, skip fetching (useful when data is provided externally) */
    enabled?: boolean;
  } = {}
) {
  const { refreshInterval = 0, runId, enabled = true } = options;

  const [data, setData] = useState<WorkflowRun | Step | Hook | Event | null>(
    null
  );
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setData(null);
    setError(null);
    if (resource === 'hook') {
      const { error, result } = await unwrapServerActionResult(
        fetchHook(env, resourceId, 'all')
      );
      if (error) {
        setError(error);
        return;
      }
      setData(hydrateResourceIO(result));
      return;
    }
    if (resource === 'sleep') {
      const { error, result } = await unwrapServerActionResult(
        fetchEventsByCorrelationId(env, resourceId, {
          sortOrder: 'asc',
          limit: 100,
          withData: true,
        })
      );
      if (error) {
        setError(error);
        return;
      }
      const events = (result.data as unknown as Event[]).map(hydrateResourceIO);
      const data = waitEventsToWaitEntity(events);
      if (data === null) {
        setError(
          new Error(
            `Failed to load ${resource} details: missing required event data`
          )
        );
        return;
      }
      setData(data as unknown as Hook | Event);
      return;
    }
    setLoading(true);
    // Fetch resource with full data
    try {
      const { data: resourceData } = await fetchResourceWithCorrelationId(
        env,
        resource,
        resourceId,
        { runId }
      );
      setData(resourceData);
    } catch (error: unknown) {
      if (error instanceof Error) {
        setError(error);
      } else {
        setError(new Error(String(error)));
      }
      return;
    } finally {
      setLoading(false);
    }
  }, [env, resource, resourceId, runId, enabled]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh interval
  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0) {
      return;
    }

    const interval = setInterval(fetchData, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval, fetchData]);

  return {
    data,
    loading,
    error,
    refresh: fetchData,
  };
}
