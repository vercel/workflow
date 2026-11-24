import type { RunUsage } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrapOrThrow } from '~/lib/client/workflow-errors';
import { fetchRunUsage } from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

/** How often a run that has not finished re-reads its usage. */
export const RUN_USAGE_REFRESH_INTERVAL_MS = 5000;

/**
 * A poll waits at least this many times as long as the last read took. On
 * the Local World a read holds the server while it runs, so a run whose
 * usage is slow to read is read less often, and the server stays free for
 * everything else at least 90% of the time.
 */
export const SLOW_READ_BACKOFF = 10;

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
 * It polls while the run is live or its last usage read was still in
 * progress, and stops once neither is true.
 *
 * Polls never stack: the next one is scheduled when the last one has
 * answered, `max(refreshInterval, SLOW_READ_BACKOFF × its duration)` later,
 * and a poll that comes due while another read is in flight is skipped.
 * Every other trigger reads regardless.
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
  const lastReadMsRef = useRef(0);
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
    const startedAt = Date.now();
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
      lastReadMsRef.current = Date.now() - startedAt;
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

  // First read (and a new one for another run).
  useEffect(() => {
    if (!enabled) return;
    void read();
  }, [enabled, read]);

  // A fresh read when the run stops being live, so a run that just finished
  // shows its final numbers. Not when it becomes live: on first load the
  // page reads the run after the first usage read started, so `live` goes
  // from false to true at once, and polling already reads a live run.
  const wasLiveRef = useRef(live);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = live;
    if (enabled && wasLive && !live) void read();
  }, [enabled, live, read]);

  // A World without usage answers `null` every time: no point polling it.
  const unsupported = usage === null;
  // Poll while the page reads the run as live, and also while the last usage
  // read was taken mid-run: the run can finish between that read and the
  // page's own read of the run, which then never reads as live, so `live`
  // never flips and nothing else would read the final numbers.
  const polling = live || usage?.inProgress === true;
  useEffect(() => {
    if (!enabled || !polling || unsupported) return;
    if (!refreshInterval || refreshInterval <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = Math.max(
        refreshInterval,
        SLOW_READ_BACKOFF * lastReadMsRef.current
      );
      timer = setTimeout(async () => {
        if (cancelled) return;
        if (inFlightRef.current === 0) await read();
        if (!cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, polling, unsupported, refreshInterval, read]);

  return { usage, loading, error, refresh: read };
}
