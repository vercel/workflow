import {
  hydrateResourceIO,
  hydrateResourceIOWithKey,
  waitEventsToWaitEntity,
} from '@workflow/web-shared';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  unwrapOrThrow,
  WorkflowWebAPIError,
} from '~/lib/client/workflow-errors';
import { fetchEvents, fetchHook, fetchRun, fetchStep } from '~/lib/rpc-client';
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

  return { data: resourceData, correlationId };
}

export async function fetchSpanDetailResource(
  env: EnvMap,
  selection: {
    resource: 'run' | 'step' | 'hook' | 'sleep';
    resourceId: string;
    runId?: string;
  },
  options: { encryptionKey?: Uint8Array } = {}
): Promise<WorkflowRun | Step | Hook | Event> {
  const { resource, resourceId, runId } = selection;
  const { encryptionKey } = options;
  const hydrate = async <T>(value: T): Promise<T> =>
    encryptionKey
      ? hydrateResourceIOWithKey(value, encryptionKey)
      : hydrateResourceIO(value);

  if (resource === 'hook') {
    const result = await unwrapOrThrow(fetchHook(env, resourceId, 'all'));
    return hydrate(result);
  }

  if (resource === 'sleep') {
    if (!runId) {
      throw new WorkflowWebAPIError(
        'runId is required for loading sleep details',
        { layer: 'client' }
      );
    }
    const result = await unwrapOrThrow(
      fetchEvents(env, runId, { sortOrder: 'asc', limit: 1000, withData: true })
    );
    const allEvents = (result.data as unknown as Event[]).map(
      hydrateResourceIO
    );
    const waitEvents = await Promise.all(
      allEvents.filter((e) => e.correlationId === resourceId).map(hydrate)
    );
    const data = waitEventsToWaitEntity(waitEvents);
    if (data === null) {
      throw new WorkflowWebAPIError(
        `Failed to load ${resource} details: missing required event data`,
        { layer: 'client' }
      );
    }
    return data as unknown as Event;
  }

  const { data } = await fetchResourceWithCorrelationId(
    env,
    resource,
    resourceId,
    {
      runId,
    }
  );
  return hydrate(data);
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
    /** Encryption key for decrypting encrypted data fields */
    encryptionKey?: Uint8Array;
  } = {}
) {
  const { refreshInterval = 0, runId, enabled = true, encryptionKey } = options;

  const [data, setData] = useState<WorkflowRun | Step | Hook | Event | null>(
    null
  );
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  const prevSelectionRef = useRef('');

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    // Only clear data when the selection actually changes (different
    // resource/id). Re-fetches for the same selection (e.g. encryption
    // key change) keep the previous data visible to avoid flicker.
    const selectionKey = `${resource}:${resourceId}`;
    if (selectionKey !== prevSelectionRef.current) {
      setData(null);
      prevSelectionRef.current = selectionKey;
    }
    setError(null);
    setLoading(true);
    try {
      const result = await fetchSpanDetailResource(
        env,
        { resource, resourceId, runId },
        { encryptionKey }
      );
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [env, resource, resourceId, runId, enabled, encryptionKey]);

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
