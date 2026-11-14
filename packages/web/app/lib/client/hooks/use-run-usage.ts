import type { RunUsage } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrapOrThrow } from '~/lib/client/workflow-errors';
import { fetchRunUsage } from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

/** How often a run that has not finished re-reads its usage. */
export const RUN_USAGE_REFRESH_INTERVAL_MS = 5000;

export interface RunUsageState {
  /** `undefined` until the first read; `null` when the World has no usage. */
  usage: RunUsage | null | undefined;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * A run's usage, counted over its whole log by the World (not over the
 * events this page has loaded), and re-read while the run is live.
 *
 * Reads can overlap (a poll, the run finishing, a run change), and finish
 * in any order. The last read started wins: a response from an earlier one
 * is dropped, so a slow read of an older log never replaces a newer count.
 * A poll is skipped while a read is in flight, so a slow World is not
 * stacked up with reads; every other trigger reads regardless.
 */
export function useRunUsage(
  env: EnvMap,
  runId: string,
  {
    enabled = true,
    live = false,
    refreshInterval = RUN_USAGE_REFRESH_INTERVAL_MS,
  }: { enabled?: boolean; live?: boolean; refreshInterval?: number } = {}
): RunUsageState {
  const [usage, setUsage] = useState<RunUsage | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const latestRef = useRef(0);
  const inFlightRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const seq = ++latestRef.current;
    // Only the newest read, on a mounted hook, writes state.
    const isCurrent = () => mountedRef.current && seq === latestRef.current;
    inFlightRef.current++;
    setLoading(true);
    try {
      const result = await unwrapOrThrow(fetchRunUsage(env, runId));
      if (isCurrent()) {
        setUsage(result);
        setError(null);
      }
    } catch (err) {
      // Keep the last good numbers on screen; the error says they are stale.
      if (isCurrent()) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      inFlightRef.current--;
      if (isCurrent()) setLoading(false);
    }
  }, [env, runId]);

  // A new run starts from nothing: never show one run's usage on another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on run change
  useEffect(() => {
    setUsage(undefined);
    setError(null);
  }, [runId]);

  // First read, and a fresh read whenever the run starts or stops being
  // live, so a run that just finished shows its final numbers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when `live` flips
  useEffect(() => {
    if (!enabled) return;
    void read();
  }, [enabled, read, live]);

  // A World without usage answers `null` every time: no point polling it.
  const unsupported = usage === null;
  useEffect(() => {
    if (!enabled || !live || unsupported) return;
    if (!refreshInterval || refreshInterval <= 0) return;
    const interval = setInterval(() => {
      if (inFlightRef.current > 0) return;
      void read();
    }, refreshInterval);
    return () => clearInterval(interval);
  }, [enabled, live, unsupported, refreshInterval, read]);

  return { usage, loading, error, refresh: read };
}
