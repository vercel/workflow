'use client';

import {
  fetchGraphManifest,
  unwrapServerActionResult,
  WorkflowAPIError,
} from '@workflow/web-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { worldConfigToEnvMap } from '@/lib/config';
import type { WorldConfig } from '@/lib/config-world';
import type { WorkflowGraphManifest } from '@/lib/workflow-graph-types';

/**
 * Hook to fetch the workflow graph manifest from the workflow data directory
 * The manifest contains static structure information about all workflows
 */
export function useWorkflowGraphManifest(config: WorldConfig) {
  const [manifest, setManifest] = useState<WorkflowGraphManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const isFetchingRef = useRef(false);

  const fetchManifest = useCallback(async () => {
    if (isFetchingRef.current) {
      return;
    }
    isFetchingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const env = worldConfigToEnvMap(config);
      const serverResult = await fetchGraphManifest(env);
      const result = unwrapServerActionResult(serverResult);
      setManifest(result);
    } catch (err) {
      const error =
        err instanceof WorkflowAPIError
          ? err
          : err instanceof Error
            ? new WorkflowAPIError(err.message, { cause: err, layer: 'client' })
            : new WorkflowAPIError(String(err), { layer: 'client' });
      setError(error);
      setManifest(null);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [config]);

  useEffect(() => {
    fetchManifest();
  }, [fetchManifest]);

  return {
    manifest,
    loading,
    error,
    refetch: fetchManifest,
  };
}
