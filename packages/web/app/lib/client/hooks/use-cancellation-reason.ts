import type { Event, WorkflowRunStatus } from '@workflow/world';
import { useEffect, useMemo, useState } from 'react';
import { getCancellationReason } from '~/lib/cancellation-reason';
import { fetchEvents } from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';
import { unwrapServerActionResult } from '../workflow-errors';

/**
 * Reads the cancellation reason from loaded trace events, falling back to the
 * terminal event for long runs whose initial trace page does not include it.
 */
export function useCancellationReason(
  env: EnvMap,
  runId: string,
  status: WorkflowRunStatus | undefined,
  events: readonly Event[] | null | undefined
): string | undefined {
  const loadedReason = useMemo(() => getCancellationReason(events), [events]);
  const [terminalReason, setTerminalReason] = useState<string>();

  useEffect(() => {
    setTerminalReason(undefined);
    if (status !== 'cancelled' || loadedReason) return;

    let ignore = false;
    void unwrapServerActionResult(
      fetchEvents(env, runId, {
        sortOrder: 'desc',
        limit: 1,
        withData: false,
      })
    ).then(({ error, result }) => {
      if (!ignore && !error) {
        setTerminalReason(getCancellationReason(result.data));
      }
    });

    return () => {
      ignore = true;
    };
  }, [env, runId, status, loadedReason]);

  return loadedReason ?? terminalReason;
}
