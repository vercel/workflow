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
 * produced workflow function and any thrown errors are byte-identical to the
 * previous re-parse-every-time behaviour.
 *
 * Keying
 * ------
 * Keyed by `code` then `filename`. The `filename` is part of the key because
 * it is baked into the compiled script's source attribution and surfaces in
 * stack traces (and is consumed by `remapErrorStack` at runtime). Two
 * workflows in the same bundle share the same `code` but can have different
 * `filename`s, so they must not share a compiled `Script`. The number of
 * distinct `(code, filename)` pairs in a process is bounded by
 * (bundle versions) × (workflow names) and is small in practice.
 *
 * We use a nested Map (code -> filename -> Script) so that swapping the bundle
 * (e.g. a new deployment/hot-reload producing a different `code`) lets the old
 * code string and all its per-filename scripts become unreachable together.
 */
const scriptCache = new Map<string, Map<string, Script>>();

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
  let byFilename = scriptCache.get(code);
  if (byFilename === undefined) {
    byFilename = new Map<string, Script>();
    scriptCache.set(code, byFilename);
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
