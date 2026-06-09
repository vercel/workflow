import {
  hydrateResourceIO,
  hydrateResourceIOWithKey,
  type SpanSelectionInfo,
  waitEventsToWaitEntity,
} from '@workflow/web-shared';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  unwrapOrThrow,
  unwrapServerActionResult,
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

/**
 * Fetches the detail for a selected span (run/step/sleep), resolving and
 * hydrating input/output/metadata. Hooks return null — they can be
 * auto-disposed and the span's inline data is sufficient. Throws on error so
 * the caller's keyed fetch hook (web-shared `useSpanDetail`) owns the loading
 * and error lifecycle.
 */
export async function fetchSpanDetailData(
  env: EnvMap,
  info: SpanSelectionInfo,
  encryptionKey?: Uint8Array
): Promise<WorkflowRun | Step | Hook | Event | null> {
  const hydrate = <T>(resource: T): Promise<T> =>
    encryptionKey
      ? hydrateResourceIOWithKey(resource, encryptionKey)
      : hydrateResourceIO(resource);

  if (info.resource === 'hook') {
    return null;
  }

  if (info.resource === 'sleep') {
    if (!info.runId) {
      throw new Error('runId is required for loading sleep details');
    }
    const { error, result } = await unwrapServerActionResult(
      fetchEvents(env, info.runId, {
        sortOrder: 'asc',
        limit: 1000,
        withData: true,
      })
    );
    if (error) {
      throw error;
    }
    const allEvents = (result.data as unknown as Event[]).map(
      hydrateResourceIO
    );
    const waitEvents = await Promise.all(
      allEvents.filter((e) => e.correlationId === info.resourceId).map(hydrate)
    );
    const wait = waitEventsToWaitEntity(waitEvents);
    if (wait === null) {
      throw new Error(
        'Failed to load sleep details: missing required event data'
      );
    }
    return wait as unknown as Hook | Event;
  }

  const { data } = await fetchResourceWithCorrelationId(
    env,
    info.resource,
    info.resourceId,
    { runId: info.runId }
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

  // Hydrate a resource, decrypting if an encryption key is available
  const hydrate = useCallback(
    async <T>(resource: T): Promise<T> =>
      encryptionKey
        ? hydrateResourceIOWithKey(resource, encryptionKey)
        : hydrateResourceIO(resource),
    [encryptionKey]
  );

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
      // fetchSpanDetailData skips hooks (the trace detail panel renders them
      // from span data), but this hook's consumers want them fetched.
      const result =
        resource === 'hook'
          ? await hydrate(
              await unwrapOrThrow(fetchHook(env, resourceId, 'all'))
            )
          : await fetchSpanDetailData(
              env,
              { resource, resourceId, runId },
              encryptionKey
            );
      setData(result);
    } catch (error: unknown) {
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoading(false);
    }
  }, [env, resource, resourceId, runId, enabled, hydrate, encryptionKey]);

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
