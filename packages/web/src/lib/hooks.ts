'use client';

import useSWR from 'swr';
import {
  checkWorldsAvailability,
  resolveDataDirInfo,
  type WorkflowDataDirInfo,
} from './config-world';

export function useWorldsAvailability() {
  return useSWR('worlds-availability', checkWorldsAvailability, {
    revalidateOnFocus: false,
  });
}

/**
 * Hook that resolves a dataDir path to WorkflowDataDirInfo.
 * Returns the dataDir and shortName for display purposes.
 */
export function useDataDirInfo(dataDir: string) {
  return useSWR<WorkflowDataDirInfo>(
    dataDir ? `data-dir-info:${dataDir}` : 'data-dir-info:cwd',
    () => resolveDataDirInfo(dataDir),
    {
      revalidateOnFocus: false,
    }
  );
}
