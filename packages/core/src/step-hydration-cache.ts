/**
 * Per-run memoization cache for hydrated step return values.
 *
 * ## Why
 *
 * The inline replay loop (`runtime.ts`) re-runs the workflow body from the top
 * on every iteration, re-consuming the full event log each time. For every
 * already-completed step, the step consumer (`step.ts`) re-runs
 * `hydrateStepReturnValue` — which AES-GCM-decrypts and devalue-parses the
 * serialized result — even though that exact result was already hydrated on
 * every prior replay. For a sequential workflow of N steps, replay K hydrates
 * K results, so the total work across a single invocation is O(N²)
 * decrypt+parse operations.
 *
 * This cache makes a completed step's hydrated result available in O(1) on
 * subsequent replays within the SAME invocation, turning the aggregate cost
 * into O(N).
 *
 * ## Scope / lifetime
 *
 * The cache is owned by the inline loop in `runtime.ts` (one per workflow run
 * invocation) and passed into `runWorkflow` so it survives across the loop's
 * iterations but never leaks across unrelated runs or process-level
 * invocations. A fresh `runWorkflow` / `WorkflowOrchestratorContext` is created
 * each iteration, so the cache must live OUTSIDE the per-iteration context.
 *
 * ## Keying
 *
 * Entries are keyed by the persisted event's `eventId` — a stable,
 * world-assigned identifier for the `step_completed` event whose serialized
 * `result` is being hydrated. The same event (same `eventId`) carries the same
 * immutable serialized bytes across every replay, so a hit is guaranteed to
 * correspond to the identical input.
 *
 * ## Identity safety (why primitives only)
 *
 * `hydrateStepReturnValue` (devalue.parse) produces a FRESH object graph on
 * every call, and each replay iteration runs in a FRESH workflow VM. The
 * current (uncached) behavior therefore hands the workflow a brand-new value
 * on every replay. If we cached and returned the SAME object reference across
 * replays, workflow code that mutates a step result (`const r = await step();
 * r.count++`) would observe the mutation from a previous replay on the next
 * replay — a non-deterministic divergence. Structured-cloning on each hit is
 * both lossy (revivers reconstruct stream handles, step-function proxies,
 * Request/Response, and AbortController/AbortSignal class instances that don't
 * survive a structured clone) and still O(size).
 *
 * So we only cache values for which returning the same reference on every
 * replay is provably indistinguishable from re-hydrating: JavaScript
 * primitives (string, number, boolean, bigint, symbol, null, undefined).
 * Primitives are immutable and compared by value, so sharing the reference is
 * byte-for-byte equivalent to re-parsing. Any non-primitive result falls
 * through to a full re-hydrate every replay, preserving current behavior
 * exactly. This trades some of the optimization away in the object-returning
 * case in exchange for keeping deterministic replay airtight.
 *
 * ## Memory characteristic
 *
 * Cached entries hold the decrypted/devalue-parsed *plaintext* of a step
 * result, which is retained for the rest of the invocation on top of the
 * serialized bytes already held in `cachedEvents`. So the residual cost is:
 *
 * - **Scoped to one workflow-run invocation.** A fresh `Map` is created per
 *   invocation (in `runtime.ts`) and is unreachable / GC'd when the invocation
 *   returns. Nothing accumulates across runs or across process-level
 *   invocations.
 * - **Bounded by the number of primitive-returning completed steps in that
 *   run** — at most one small entry per such step.
 * - **Primitives only, and additionally byte-bounded.** Most primitives
 *   (numbers, booleans, null/undefined, symbols, short ids/strings) are tiny
 *   and fixed-size. The only primitive that can be large is a string (or a
 *   pathologically long bigint), so to keep the doubled-residency worst case
 *   bounded we *do not* memoize string/bigint results whose character length
 *   exceeds {@link MAX_MEMOIZED_PRIMITIVE_LENGTH}. A large string is cheap to
 *   re-hydrate relative to its footprint, so letting it fall through to the
 *   existing per-replay re-hydrate path costs little and caps peak retained
 *   memory.
 *
 * (This is a much weaker concern than a *process-wide* cache: the dominant
 * residency — the full event log in `cachedEvents` — already exists for the
 * same lifetime, and everything here is freed together with it when the
 * invocation ends.)
 */

/**
 * Upper bound, in characters, on a string/bigint primitive that may be
 * memoized. Beyond this, the value falls through to a fresh re-hydrate on every
 * replay so the cache never holds a large plaintext payload for the lifetime of
 * the invocation. 4 KiB comfortably covers ids, counts, flags, and typical
 * short string results while excluding the large-payload case the bound exists
 * to guard. Other primitive types (number, boolean, symbol, null, undefined)
 * are inherently small and are never length-checked.
 */
export const MAX_MEMOIZED_PRIMITIVE_LENGTH = 4096;

/**
 * Returns true for values that are safe to memoize and return by reference
 * across replays: JS primitives. Objects and functions are excluded because
 * sharing a mutable reference across replays could change observable behavior.
 *
 * Strings and bigints are additionally bounded by length: a value longer than
 * {@link MAX_MEMOIZED_PRIMITIVE_LENGTH} characters is treated as non-memoizable
 * so the cache never retains a large plaintext payload for the whole invocation
 * (see the module-level "Memory characteristic" docs). It re-hydrates fresh on
 * every replay instead — cheap relative to its footprint.
 *
 * Note: `typeof null === 'object'`, so it is handled explicitly. `undefined`,
 * `string`, `number`, `boolean`, `bigint`, and `symbol` are all primitives.
 */
export function isMemoizablePrimitive(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'object' || t === 'function') return false;
  // Bound the only primitive types that can carry a large payload.
  if (t === 'string') {
    return (value as string).length <= MAX_MEMOIZED_PRIMITIVE_LENGTH;
  }
  if (t === 'bigint') {
    return (value as bigint).toString().length <= MAX_MEMOIZED_PRIMITIVE_LENGTH;
  }
  return true;
}

/**
 * Cache of hydrated step return values for a single workflow run invocation.
 *
 * Keyed by `step_completed` event id; the value is the already-hydrated
 * primitive result. Only successful, primitive hydrations are stored (see
 * {@link getOrHydrateStepReturnValue}), so a non-`undefined` `has(eventId)`
 * always means "this step completed with a memoizable primitive value".
 */
export type StepHydrationCache = Map<string, unknown>;

/**
 * Create an empty per-invocation step hydration cache.
 */
export function createStepHydrationCache(): StepHydrationCache {
  return new Map();
}

/**
 * Return the hydrated step result for `eventId`, using `cache` as a per-run
 * memo. On a hit, the cached primitive is returned without re-running the
 * expensive decrypt + devalue-parse. On a miss, `hydrate()` runs and its
 * result is memoized only when it is a small primitive (see the module docs for
 * the identity-safety rationale and the length bound on string/bigint results).
 *
 * This always returns a `Promise` and `await`s `hydrate()` even on the miss
 * path, so the caller's `await` inside its serial `promiseQueue` slot keeps the
 * same scheduling on both hit and miss — a cache hit resolves through the exact
 * same promise-chain position a re-hydrate would have, preserving the
 * deterministic delivery order that `pendingDeliveries`, the delivery barriers,
 * and `Promise.race`/`Promise.all` replay all depend on.
 *
 * `has(eventId)` is used rather than `get(eventId) !== undefined` so that a
 * legitimately memoized `undefined` step result still registers as a hit.
 *
 * When `cache` or `eventId` is absent (lightweight test harnesses, or a context
 * that predates this plumbing), this degrades to calling `hydrate()` directly
 * with no memoization — identical to the previous behavior.
 *
 * Errors are intentionally never cached: a rejected hydrate propagates to the
 * caller (which rejects the step promise) and the next replay re-attempts it,
 * matching the uncached behavior and avoiding a parked rejected promise.
 */
export async function getOrHydrateStepReturnValue(
  cache: StepHydrationCache | undefined,
  eventId: string | undefined,
  hydrate: () => Promise<unknown>
): Promise<unknown> {
  if (!cache || eventId === undefined) {
    return hydrate();
  }

  if (cache.has(eventId)) {
    return cache.get(eventId);
  }

  const value = await hydrate();
  // Only memoize values that are safe to return by reference across replays
  // AND small enough to retain for the invocation. Non-primitives and
  // oversized string/bigint values fall through and are re-hydrated fresh on
  // every replay (see isMemoizablePrimitive / MAX_MEMOIZED_PRIMITIVE_LENGTH).
  if (isMemoizablePrimitive(value)) {
    cache.set(eventId, value);
  }
  return value;
}
