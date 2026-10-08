import { Script } from 'node:vm';
import { globalSingleton } from '@workflow/utils';

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
 * Keyed by `code` then `filename`. The `filename` is part of the key on
 * purpose, NOT as a dedupe key: it is baked into the compiled script's source
 * attribution and surfaces in stack traces, where `remapErrorStack` keys on it
 * to map frames back to the user's source. Two workflows in the same bundle
 * share the same `code` but have different `filename`s, so they intentionally
 * compile to distinct `Script`s; collapsing them onto a single shared `Script`
 * would misattribute one workflow's stack frames to another file. The cost of
 * keeping them distinct is that the whole bundle is compiled once per distinct
 * `filename` (not once per bundle); in practice that is bounded by the number
 * of source files that define a workflow, and because V8 lazily compiles
 * function bodies the duplicated work is the (cheap) top-level parse, not full
 * per-workflow codegen.
 *
 * We use a nested Map (code -> filename -> Script) so that evicting a source
 * string drops all of its per-filename scripts together. Most entries are full
 * workflow bundles; `compileWorkflowBundle` also caches its tiny workflow-name
 * lookup snippets here.
 *
 * Bounding
 * --------
 * The top-level (`code`-keyed) map is an insertion-ordered LRU capped at
 * `MAX_SCRIPT_SOURCES` entries. A production deployment has one large bundle
 * source plus small lookup sources; the bundle is touched immediately before
 * its lookup on every compilation, so lookup churn cannot evict the expensive
 * entry in normal use. The bound primarily protects dev/watch mode, where every
 * edit produces a new bundle string that would otherwise pin all historical
 * versions. The per-`filename` inner map is naturally bounded by the workflows
 * compiled from that source and is dropped wholesale with its parent entry.
 */
// On `globalThis` (see `globalSingleton`): compiling a bundle is the expensive
// part this cache exists to skip, and per-copy caches would pay it once per
// bundler layer that compiles a workflow.
const scripts = globalSingleton('@workflow/core//vmScriptCache', 1, () => ({
  byCode: new Map<string, Map<string, Script>>(),
}));

/**
 * Maximum number of distinct script source strings to retain. Kept deliberately
 * small because stale bundles and one-off lookup snippets have no lasting value.
 */
const MAX_SCRIPT_SOURCES = 8;

/**
 * Looks up the per-filename map for `code`, marking it most-recently-used.
 * Relies on `Map` preserving insertion order: deleting and re-inserting an
 * existing key moves it to the end (newest), so the first key is always the
 * least-recently-used eviction candidate.
 */
function touchScriptSource(code: string): Map<string, Script> | undefined {
  const byFilename = scripts.byCode.get(code);
  if (byFilename === undefined) {
    return undefined;
  }
  // Move to the most-recently-used position (end of insertion order).
  scripts.byCode.delete(code);
  scripts.byCode.set(code, byFilename);
  return byFilename;
}

/**
 * Returns a compiled `vm.Script` for the given source code and filename,
 * compiling and caching it on first use. Subsequent calls with the same
 * `(code, filename)` return the cached `Script`.
 *
 * The returned `Script` is not yet bound to any context; the caller runs it
 * against a specific VM context via `script.runInContext(context)`. This is
 * equivalent to `vm.runInContext(code, context, { filename })` but skips the
 * recompile.
 */
export function getCachedWorkflowScript(
  code: string,
  filename: string
): { script: Script; cacheHit: boolean } {
  let byFilename = touchScriptSource(code);
  if (byFilename === undefined) {
    byFilename = new Map<string, Script>();
    scripts.byCode.set(code, byFilename);
    // Evict the least-recently-used source(s) when over the cap. New sources
    // are appended at the end, so the oldest live at the front.
    while (scripts.byCode.size > MAX_SCRIPT_SOURCES) {
      const oldest = scripts.byCode.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      scripts.byCode.delete(oldest);
    }
  }
  let script = byFilename.get(filename);
  const cacheHit = script !== undefined;
  if (script === undefined) {
    script = new Script(code, { filename });
    byFilename.set(filename, script);
  }
  return { script, cacheHit };
}

/**
 * Clears the compiled-script cache. Intended for tests that want to assert
 * compile-vs-cache behaviour in isolation; not used on the hot path.
 */
export function clearWorkflowScriptCache(): void {
  scripts.byCode.clear();
}

/**
 * Number of distinct script source strings currently retained. Exposed for
 * tests asserting the LRU bound; not used on the hot path.
 */
export function workflowScriptCacheSize(): number {
  return scripts.byCode.size;
}
