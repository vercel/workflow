import { type Context, Script } from 'node:vm';
import { globalSingleton } from '@workflow/utils';

/**
 * Module-level cache of compiled workflow-bundle `vm.Script` objects.
 *
 * Why this exists
 * ---------------
 * Replaying a workflow re-evaluates the workflow bundle against a fresh VM
 * context on every iteration of the inline replay loop (see
 * `runWorkflow` in `../workflow.ts`). Each source bundle registers its
 * workflow functions on `globalThis.__private_workflows`. Previously each replay called
 * `vm.runInContext(workflowCode, context, { filename })`, which RE-PARSES and
 * RE-COMPILES the entire bundle every time: O(N) full re-parses for a
 * sequential workflow of N steps, plus the same parse cost repeated across
 * every invocation in the process.
 *
 * Compilation is a pure function of `(code, filename)`: a `vm.Script` carries
 * no realm/context state; it is only bound to a context at `runInContext`
 * time. So a single compiled `Script` can be reused across replays AND across
 * workflow invocations in the same process without affecting determinism: the
 * produced workflow function is identical to the previous re-parse-every-time
 * behaviour, with identical `filename` source attribution (see the precise
 * claim, and its one caveat, in `runWorkflow`).
 *
 * Keying
 * ------
 * Keyed by `filename` then `code`. The `filename` is part of the key on
 * purpose, NOT as a dedupe key: it is baked into the compiled script's source
 * attribution and surfaces in stack traces, where `remapErrorStack` keys on it
 * to map frames back to the user's source. A legacy monolithic bundle can use
 * the same `code` under several source filenames, so those combinations must
 * compile to distinct `Script`s; collapsing them would misattribute stack
 * frames. Per-source bundles normally have one filename each.
 *
 * We use a nested Map (filename -> code -> Script) so development builds can
 * retain the current bundle for every workflow source while independently
 * bounding the historical versions created by hot reloads.
 *
 * Bounding
 * --------
 * In production, a deployment's immutable set of source bundles naturally
 * bounds this cache. In dev/watch mode, each source's `code` map is an
 * insertion-ordered LRU capped at `MAX_DEV_BUNDLE_VERSIONS_PER_SOURCE`: every
 * edit produces a new bundle string, but unrelated workflow sources must not
 * evict one another. This bounds hot-reload history without making an app with
 * more than eight workflow sources recompile on every replay.
 */
// On `globalThis` (see `globalSingleton`): compiling a bundle is the expensive
// part this cache exists to skip, and per-copy caches would pay it once per
// bundler layer that compiles a workflow.
const scripts = globalSingleton('@workflow/core//vmScriptCache', 2, () => ({
  byFilename: new Map<string, Map<string, Script>>(),
}));

/**
 * Max number of distinct bundle versions retained per source outside
 * production. There is no value in pinning every stale dev build.
 */
const MAX_DEV_BUNDLE_VERSIONS_PER_SOURCE = 8;

/**
 * Looks up a compiled script for `(filename, code)`, marking that code version
 * most-recently-used within its source.
 * Relies on `Map` preserving insertion order: deleting and re-inserting an
 * existing key moves it to the end (newest), so the first key is always the
 * least-recently-used eviction candidate.
 */
function touchScript(filename: string, code: string): Script | undefined {
  const byCode = scripts.byFilename.get(filename);
  if (byCode === undefined) {
    return undefined;
  }
  const script = byCode.get(code);
  if (script === undefined) {
    return undefined;
  }
  // Move to the most-recently-used position (end of insertion order).
  byCode.delete(code);
  byCode.set(code, script);
  return script;
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
  let script = touchScript(filename, code);
  if (script !== undefined) {
    return script;
  }

  let byCode = scripts.byFilename.get(filename);
  if (byCode === undefined) {
    byCode = new Map<string, Script>();
    scripts.byFilename.set(filename, byCode);
  }
  script = new Script(code, { filename });
  byCode.set(code, script);

  // Evict least-recently-used hot-reload versions for this source. New code is
  // appended at the end, so the oldest version lives at the front.
  if (process.env.NODE_ENV !== 'production') {
    while (byCode.size > MAX_DEV_BUNDLE_VERSIONS_PER_SOURCE) {
      const oldest = byCode.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      byCode.delete(oldest);
    }
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
  scripts.byFilename.clear();
}

/**
 * Number of compiled `(filename, code)` scripts currently retained. Exposed
 * for tests asserting the LRU bound; not used on the hot path.
 */
export function workflowScriptCacheSize(): number {
  let size = 0;
  for (const byCode of scripts.byFilename.values()) {
    size += byCode.size;
  }
  return size;
}
