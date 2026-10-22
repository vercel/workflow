import { globalSingleton } from '@workflow/utils';
import type { Hook as WorldHook } from '@workflow/world';
import { envNumber } from '@workflow/world';

/**
 * A short-lived, process-wide cache of `hooks.getByToken` results for the
 * hook-resume path.
 *
 * Why: `resumeHook(token, payload)` is strictly serial (lookup, durable
 * `hook_received` write, wake publish), so the by-token lookup is one full
 * round trip on every resume. The resumes that matter for latency are
 * repeated deliveries to one long-lived hook: the next chat message to an
 * agent session's inbox, the next webhook for the same subscription. That
 * hook's `(runId, hookId, resumeContext)` does not change between deliveries,
 * so re-reading it each time is pure latency.
 *
 * Why it is safe to be optimistic: a stale entry can only name a hook that is
 * gone (disposed, its run ended, or its token taken over). The durable write
 * against such a hook is refused and commits nothing, the entry is evicted,
 * and the resume retries once with a fresh lookup (see `resume-hook.ts`). The
 * worst case of a stale hit is one wasted write round trip, paid only after a
 * hook actually moved.
 *
 * The one piece of a lookup that is meant to be fresh is the server's
 * response-only dedup attestation (`resumeCapabilities`): a server kill
 * switch withdraws it on the next lookup. A cached attestation can lag that
 * by at most the TTL, which is what bounds the TTL. A withdrawn attestation
 * only matters if a transport retry of the write happens inside that window.
 *
 * Scoped per World instance, so two Worlds in one process (and tests that
 * build a fresh mock World each) never share entries.
 *
 * `WORKFLOW_HOOK_LOOKUP_CACHE_TTL_MS` sets the TTL; `0` disables the cache.
 */

/** Default entry lifetime; see the module comment for what bounds it. */
export const HOOK_LOOKUP_CACHE_TTL_MS = 60_000;

/** Entries kept per World before the oldest is evicted. */
const MAX_ENTRIES = 1024;

interface Entry {
  hook: WorldHook;
  expiresAt: number;
}

const state = globalSingleton('@workflow/core//hookLookupCache', 1, () => ({
  byWorld: new WeakMap<object, Map<string, Entry>>(),
}));

export function getHookLookupCacheTtlMs(): number {
  return envNumber(
    'WORKFLOW_HOOK_LOOKUP_CACHE_TTL_MS',
    HOOK_LOOKUP_CACHE_TTL_MS,
    { integer: true, min: 0, max: 600_000 }
  );
}

/** A fresh-enough cached lookup for `token`, or undefined. */
export function getCachedHookLookup(
  world: object,
  token: string
): WorldHook | undefined {
  const entries = state.byWorld.get(world);
  const entry = entries?.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries?.delete(token);
    return undefined;
  }
  return entry.hook;
}

/**
 * Remember a by-token lookup. Only hooks carrying a stored `resumeContext`
 * are cached: older hooks need a run read on every resume anyway, and their
 * terminal-run check depends on that read being current.
 */
export function cacheHookLookup(
  world: object,
  token: string,
  hook: WorldHook
): void {
  const ttlMs = getHookLookupCacheTtlMs();
  if (ttlMs <= 0 || !hook.resumeContext) return;
  let entries = state.byWorld.get(world);
  if (!entries) {
    entries = new Map();
    state.byWorld.set(world, entries);
  }
  // Re-insert so Map order tracks recency for eviction.
  entries.delete(token);
  entries.set(token, { hook, expiresAt: Date.now() + ttlMs });
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** Forget `token` (after a resume against the cached hook failed). */
export function evictHookLookup(world: object, token: string): void {
  state.byWorld.get(world)?.delete(token);
}
