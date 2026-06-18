import { type Context, Script } from 'node:vm';

/**
 * Module-level cache of compiled workflow-bundle `vm.Script` objects.
 *
 * Why this exists
 * ---------------
 * Replaying a workflow re-evaluates the workflow bundle against a fresh VM
 * context on every iteration of the inline replay loop (see
 * `runWorkflow` in `../workflow.ts`). The bundle is a single string that
 * contains every workflow function in the app and registers them on
 * `globalThis.__private_workflows`. Previously each replay called
 * `vm.runInContext(workflowCode, context, { filename })`, which RE-PARSES and
 * RE-COMPILES the entire bundle every time — O(N) full re-parses for a
 * sequential workflow of N steps, plus the same parse cost repeated across
 * every invocation in the process.
 *
 * Compilation is a pure function of `(code, filename)`: a `vm.Script` carries
 * no realm/context state — it is only bound to a context at `runInContext`
 * time. So a single compiled `Script` can be reused across replays AND across
 * workflow invocations in the same process without affecting determinism: the
 * produced workflow function is identical to the previous re-parse-every-time
 * behaviour, with identical `filename` source attribution (see the precise
 * claim — and its one caveat — in `runWorkflow`).
 *
 * Keying
 * ------
 * Keyed by `code` then `filename`. The `filename` is part of the key on
 * purpose, NOT as a dedupe key: it is baked into the compiled script's source
 * attribution and surfaces in stack traces, where `remapErrorStack` keys on it
 * to map frames back to the user's source. Two workflows in the same bundle
 * share the same `code` but have different `filename`s, so they intentionally
 * compile to distinct `Script`s — collapsing them onto a single shared `Script`
 * would misattribute one workflow's stack frames to another file. The cost of
 * keeping them distinct is that the whole bundle is compiled once per distinct
 * `filename` (not once per bundle); in practice that is bounded by the number
 * of source files that define a workflow, and because V8 lazily compiles
 * function bodies the duplicated work is the (cheap) top-level parse, not full
 * per-workflow codegen.
 *
 * We use a nested Map (code -> filename -> Script) so that evicting a bundle
 * (e.g. a new deployment/hot-reload producing a different `code`) drops the old
 * code string and all of its per-filename scripts together.
 *
 * Bounding
 * --------
 * The top-level (`code`-keyed) map is an insertion-ordered LRU capped at
 * `MAX_BUNDLES` entries. In production this bound is never reached: a
 * deployment is its own process serving exactly one build-time bundle literal
 * (skew protection runs old versions as separate processes), so there is a
 * single `code` key for the process lifetime. The bound exists for dev/watch
 * mode, where the dev route re-reads `workflowCode` from disk and re-invokes
 * the entrypoint on every edit — each edit produces a NEW bundle string, which
 * without a bound would pin every historical version forever (~0.8MB per edit,
 * growing monotonically with edit count). The dev path only ever needs the
 * latest bundle, so an LRU that keeps the few most-recent bundles and evicts
 * the rest preserves the pre-cache GC behaviour while still serving the
 * steady-state single-bundle case for free. The per-`filename` inner map is not
 * separately bounded: it is naturally bounded by the (small) number of workflow
 * source files in a bundle and is dropped wholesale when its parent `code`
 * entry is evicted.
 */
const scriptCache = new Map<string, Map<string, Script>>();

/**
 * Max number of distinct bundle (`code`) versions to retain. One is enough for
 * production; a handful covers pathological dev hot-reload / repeated-rebuild
 * churn within a single long-lived process (e.g. a watch session or a test
 * file) without unbounded growth. Kept deliberately small — there is no value
 * in retaining stale bundles, only a memory cost.
 */
const MAX_BUNDLES = 8;

/**
 * Looks up the per-filename map for `code`, marking it most-recently-used.
 * Relies on `Map` preserving insertion order: deleting and re-inserting an
 * existing key moves it to the end (newest), so the first key is always the
 * least-recently-used eviction candidate.
 */
function touchBundle(code: string): Map<string, Script> | undefined {
  const byFilename = scriptCache.get(code);
  if (byFilename === undefined) {
    return undefined;
  }
  // Move to the most-recently-used position (end of insertion order).
  scriptCache.delete(code);
  scriptCache.set(code, byFilename);
  return byFilename;
}

/**
 * Returns a compiled `vm.Script` for the given workflow bundle code and
 * filename, compiling and caching it on first use. Subsequent calls with the
 * same `(code, filename)` return the cached `Script`.
 *
 * The returned `Script` is not yet bound to any context; the caller runs it
 * against a specific VM context via `script.runInContext(context)`. This is
 * equivalent to `vm.runInContext(code, context, { filename })` but skips the
 * recompile.
 */
export function getCachedWorkflowScript(
  code: string,
  filename: string
): Script {
  let byFilename = touchBundle(code);
  if (byFilename === undefined) {
    byFilename = new Map<string, Script>();
    scriptCache.set(code, byFilename);
    // Evict the least-recently-used bundle(s) when over the cap. New bundles
    // are appended at the end, so the oldest live at the front.
    while (scriptCache.size > MAX_BUNDLES) {
      const oldest = scriptCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      scriptCache.delete(oldest);
    }
  }
  let script = byFilename.get(filename);
  if (script === undefined) {
    script = new Script(code, { filename });
    byFilename.set(filename, script);
  }
  return script;
}

/**
 * Runs the cached workflow-bundle `Script` against `context`. Compiles and
 * caches the `Script` on first use for the given `(code, filename)`.
 */
export function runCachedWorkflowScript(
  code: string,
  filename: string,
  context: Context
): unknown {
  return getCachedWorkflowScript(code, filename).runInContext(context);
}

/**
 * Clears the compiled-script cache. Intended for tests that want to assert
 * compile-vs-cache behaviour in isolation; not used on the hot path.
 */
export function clearWorkflowScriptCache(): void {
  scriptCache.clear();
}

/**
 * Number of distinct bundle (`code`) versions currently retained. Exposed for
 * tests asserting the LRU bound; not used on the hot path.
 */
export function workflowScriptCacheSize(): number {
  return scriptCache.size;
}
