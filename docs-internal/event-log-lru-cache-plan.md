# Implementation Plan: Per-Run Event-Log LRU Cache (client SDK)

> Status: proposed (for a follow-up implementation session)
> Scope: `@workflow/core` client runtime only. No `workflow-server` changes required.
> Author context: derived from a production investigation of `GET /api/v3/runs/:runId/events`
> latency (DD monitor 270389590).

## 1. Problem statement

On every workflow **resume** (queue wake-up), the core runtime re-reads the run's
event log from event 0:

`packages/core/src/runtime.ts:460-475`
```ts
if (preloadedEvents) {
  events = preloadedEvents;            // small runs: inline from run_started POST
  eventsCursor = preloadedEventsCursor;
} else {
  const loadedEvents = await getWorkflowRunEvents(workflowRun.runId); // full reload from event 0
  events = loadedEvents.events;
  eventsCursor = loadedEvents.cursor;
}
```

There is **no cross-invocation cache**. A workflow with `N` steps that resumes ~once per
step re-reads a growing log each time → **O(N²)** total event reads over the run's life,
paginated at the server default page size (20). In production this manifested as a single
large run (`wrun_01KT2FS57T5Q8ZFXYYTNMSHWRF`) issuing 417 slow (>2s) DynamoDB queries in 20
minutes and dragging production p99 over the 1s alert threshold. The slow time is in
strongly-consistent base-table `Query`s on `event / byWorkflowRunId` (pk = runId), amplified
by retries (transport `RetryAgent`, queue redelivery — same amplifiers as inc-6095).

### Why a cache helps

`getWorkflowRunEvents(runId, cursor?)` already supports **incremental** loading: when a
cursor is passed it loads only events *after* that cursor
(`packages/core/src/runtime/helpers.ts:434-437`, used today by the `wait_completed` delta
path at `runtime.ts:587-591`). The machinery exists; what's missing is something to carry the
cursor + already-loaded events across resumes on a warm instance.

A module-level LRU keyed by `runId` provides exactly that. On a **hot instance** a resume
becomes O(delta): fetch only events since the cached cursor, merge, replay. This converts the
warm-replay path from O(N²) → O(N).

## 2. Goals / non-goals

**Goals**
- Eliminate repeated full event-log reloads on warm instances.
- Preserve replay correctness exactly (deterministic, complete, ordered event log).
- Bounded memory; one pathological run must not exhaust the cache.
- Zero `workflow-server` changes; self-healing if a cached cursor is rejected.

**Non-goals**
- Does not help cold starts / first touch of a run on an instance (still a full load —
  complemented separately by server-side default page-size bump).
- Not a distributed/shared cache; per-process only. Low cache locality workloads (each
  resume on a different instance) see little benefit — acceptable, since the problematic runs
  are hot, long-lived, and tend to reuse a warm instance.
- Does not change the pagination contract or `hasMore`/cursor semantics.

## 3. Design

### 3.1 Decisions (locked)
- **Scope:** module-level singleton in `@workflow/core` runtime (process-wide, shared across
  all runs on the instance).
- **Trust model:** **always delta-fetch from the cached cursor on a hit** (never serve purely
  from cache). This is correct against concurrent writes from other instances and still saves
  the bulk of the reads.

### 3.2 New module: `packages/core/src/runtime/event-cache.ts`

Cache entry value:
```ts
import type { Event } from '...'; // same Event type used by helpers.ts

interface CachedRunEvents {
  events: Event[];        // full, ordered, deduped log loaded/replayed so far
  cursor: string | null;  // last non-null cursor returned by the server (see helpers.ts:502-510)
}
```

Public surface (keep minimal):
```ts
export function getCachedRunEvents(runId: string): CachedRunEvents | undefined;
export function setCachedRunEvents(runId: string, value: CachedRunEvents): void;
export function deleteCachedRunEvents(runId: string): void; // optional, for terminal runs
export function clearEventCache(): void;                    // test hook
```

**LRU implementation choice** (pick one in implementation):
- **(a) Add `lru-cache` dependency.** Not currently a dependency of `@workflow/core`
  (verified). Use `maxSize` + `sizeCalculation` for byte-aware bounding. Preferred for the
  size-awareness (entries here can be large).
- **(b) Hand-rolled tiny LRU** (Map-based, insertion-order eviction) to avoid a new
  dependency. Acceptable but must still bound by approximate bytes, not just entry count.

**Bounding (important):** event lists for the *big* runs are exactly what we cache, so bound
by **approximate total bytes**, not entry count alone. Suggested starting points (tune):
- `maxSize`: ~64 MiB total
- per-entry `sizeCalculation`: approximate via JSON/serialized length of `events` (cheap
  heuristic is fine; precision not required for eviction).
- Also a sane `max` entry count (e.g. 500) as a secondary guard.

### 3.3 Mutation safety (must address)

The runtime mutates the `events` array in place during the `wait_completed` merge
(`runtime.ts:606-611` does `events.push(...)`). If we hand out the cached array by reference
and the runtime mutates it, the cache can be corrupted or contain partially-merged state.

Choose one and document it:
- **Cache owns the array (recommended):** `getCachedRunEvents` returns a value the runtime
  treats as read-only; the runtime works on a shallow copy (`events = [...cached.events]`).
  After replay/merge completes, the runtime calls `setCachedRunEvents` with the final array.
- Or: store copies on write so external mutation can't reach into the cache.

Either way: **the array stored in the cache must equal the full set of events actually
replayed this invocation**, including any appended in the `wait_completed` branch.

### 3.4 Resume-path integration (`runtime.ts:460-475`)

Replace the `else` branch (the cold full reload) with cache-aware logic. Pseudocode:

```ts
if (preloadedEvents) {
  // unchanged: small-run inline optimization
  events = preloadedEvents;
  eventsCursor = preloadedEventsCursor;
  // opportunistically seed the cache for future resumes:
  setCachedRunEvents(runId, { events: [...events], cursor: eventsCursor ?? null });
} else {
  const cached = getCachedRunEvents(runId);
  if (cached && cached.cursor) {
    // HOT PATH: delta-fetch only events after the cached cursor.
    const delta = await getWorkflowRunEvents(runId, cached.cursor);
    // merge with dedup (appendUniqueEvents already guards overlap)
    const merged = [...cached.events];
    const seen = new Set(merged.map((e) => e.eventId));
    for (const e of delta.events) if (!seen.has(e.eventId)) { seen.add(e.eventId); merged.push(e); }
    events = merged;
    eventsCursor = delta.cursor ?? cached.cursor; // preserve last non-null cursor
    setCachedRunEvents(runId, { events: merged, cursor: eventsCursor });
  } else {
    // COLD PATH: full load as today, then populate cache.
    const loadedEvents = await getWorkflowRunEvents(runId);
    events = loadedEvents.events;
    eventsCursor = loadedEvents.cursor;
    setCachedRunEvents(runId, { events: [...events], cursor: eventsCursor ?? null });
  }
}
```

And after the `wait_completed` merge block (`runtime.ts:580-624`), write the final `events`
+ cursor back to the cache so the next resume's baseline is complete:
```ts
// end of the waitsToComplete handling, once `events` is finalized:
setCachedRunEvents(runId, { events: [...events], cursor: eventsCursor ?? null });
```

> Note: `appendUniqueEvents` (`helpers.ts:383-394`) is the existing dedup helper — reuse it
> (export it if needed) rather than re-implementing the merge.

### 3.5 Self-healing on bad cursor (no new invalidation logic needed)

`getWorkflowRunEvents` already handles a rejected cursor: `shouldRetryWithoutEventCursor`
(`helpers.ts:416-491`) catches a **400** on a cursored list call, discards loaded events, and
restarts with a full reload. So if a cached cursor is ever stale/invalid, the existing path
recovers automatically. The cache should simply:
- on a delta-load that internally fell back to a full reload, store the resulting
  (full) events + cursor as the new baseline; and
- optionally `deleteCachedRunEvents(runId)` then repopulate on any thrown error to avoid
  caching a corrupt state.

Do **not** invent a separate cache-invalidation protocol; lean on the 400 path.

### 3.6 Terminal runs

Optionally evict on observed terminal state (`run_completed` / `run_failed` / `run_cancelled`
present in the merged log) via `deleteCachedRunEvents`, since the run won't resume again.
LRU eviction also handles this passively; explicit eviction just frees memory sooner.

## 4. Correctness checklist (replay determinism)

- [ ] Always perform a delta fetch on cache hit; never replay purely from cache.
- [ ] Merge is dedup-by-`eventId` and preserves ascending order (delta is `sortOrder: 'asc'`).
- [ ] Cached `cursor` is the **last non-null** cursor (mirror `helpers.ts:502-510` semantics).
- [ ] Cached events include everything replayed, including `wait_completed` appends.
- [ ] No shared mutable array between cache and runtime (copy-on-read or copy-on-write).
- [ ] Bad-cursor 400 → existing full-reload fallback → cache repopulated with full set.
- [ ] Cache miss path is byte-for-byte equivalent to today's behavior.

## 5. Testing

Add `packages/core/src/runtime/event-cache.test.ts` and extend `runtime.test.ts`.
Test runner: `cross-env WORKFLOW_TARGET_WORLD=local vitest run src` (per
`packages/core/package.json`). Use the `world-local` test world.

Unit (cache module):
- get/set/delete round-trip; LRU eviction by count and by size; `clearEventCache`.
- `sizeCalculation` returns sane non-zero sizes; large entry triggers eviction.

Integration (runtime resume):
- **Hot resume issues a delta fetch, not a full reload.** Spy/count `world.events.list`
  calls and assert the second resume requests with the cached cursor and loads only new
  events. (This is the core regression test for the O(N²) fix.)
- **Cold resume (empty cache)** behaves exactly as today (full load) and populates cache.
- **Multi-instance write:** events appended by a "different instance" between resumes are
  picked up by the delta fetch and merged exactly once (no dupes, correct order).
- **Stale cursor (server 400):** delta fetch falls back to full reload; cache ends with the
  full, correct set; replay result identical to no-cache.
- **`wait_completed` path:** elapsed waits committed, delta merged, final events cached;
  next resume baseline includes the wait_completed events.
- **Determinism:** replaying the same run with vs. without a warm cache yields identical
  materialized state / step outputs.

## 6. Observability

- Add a span attribute / debug log on resume indicating `cacheHit: boolean`,
  `deltaEvents`, `totalEvents`, `pagesLoaded` (the loop already logs pages at
  `helpers.ts:513-520`). This lets us confirm the O(N²)→O(N) reduction in production via the
  `workflow.loadEvents` span.
- Optional counter for cache evictions to validate sizing in the field.

## 7. Rollout / risk

- Pure client-side; ships with the next `@workflow/core` release. No server coordination.
- **Feature flag / kill switch recommended:** gate the hot path behind an env var
  (e.g. `WORKFLOW_DISABLE_EVENT_CACHE=1` forces the cold full-load path) so it can be disabled
  in production without a rollback if anything looks off.
- Risk is contained: on any doubt the code can fall back to a full reload (already the
  cold-path behavior), and the 400-cursor self-heal provides a second safety net.

## 8. Relationship to complementary server-side fixes (out of scope here)

These were identified in the same investigation and are tracked separately; the cache does
**not** replace them:
1. Raise `DEFAULT_PAGE_LIMIT` (server `lib/schemas.ts:15`) — helps the *cold* full load that
   the cache can't avoid.
2. Scope the strongly-consistent first-page read to actively-progressing runs
   (`lib/data/events.ts:98, 3046-3056`) — halves RCU on replay.
3. Confirm/raise DynamoDB base-table capacity; `pk=runId` is a hot-partition risk for large
   runs (`lib/data/electrodb.ts:551`).
4. Retry/replay guardrails (transport `RetryAgent`, queue redelivery) — inc-6095 hardening.

## 9. Key file references

Client (`~/Code/vercel/workflow`):
- `packages/core/src/runtime.ts:460-475` — resume-path full reload (primary integration site).
- `packages/core/src/runtime.ts:580-624` — `wait_completed` delta/merge (reuse pattern; write back to cache).
- `packages/core/src/runtime.ts:307-316` — `run_started` inline-events optimization (seed cache here too).
- `packages/core/src/runtime/helpers.ts:434-537` — `getWorkflowRunEvents(runId, cursor?)` (delta-capable loader).
- `packages/core/src/runtime/helpers.ts:383-394` — `appendUniqueEvents` (dedup merge helper).
- `packages/core/src/runtime/helpers.ts:416-491` — `shouldRetryWithoutEventCursor` (bad-cursor self-heal).
- `packages/core/src/runtime/helpers.ts:368-371` — `LoadedWorkflowRunEvents` type.
- `packages/world-vercel/src/events.ts:282-372` — `getWorkflowRunEvents` world client (sends `remoteRefBehavior=lazy`).
- `packages/core/package.json` — no `lru-cache` dep today; test script `WORKFLOW_TARGET_WORLD=local vitest run src`.

Server (`~/Code/vercel/workflow-server`, for context only):
- `lib/data/events.ts:2899-3115` — `queryEventsWithConsistentSplit` (consistent-read split).
- `lib/data/events.ts:98` — `CONSISTENT_READ_FRESHNESS_MS = 1500`.
- `lib/schemas.ts:15` — `DEFAULT_PAGE_LIMIT = 20`.
- `lib/data/electrodb.ts:551-562` — `byWorkflowRunId` is the base table (pk = runId), not a GSI.
