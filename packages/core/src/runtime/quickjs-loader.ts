/**
 * Where the QuickJS workflow engine is found. The deliveries load it through
 * here instead of importing it themselves, so a bundle that never registers it
 * carries none of it: the per-workflow inline entries import
 * `workflowEntrypoint()` from `flow-entrypoint.ts`, without the engine, and
 * an inline delivery of a QuickJS run is declined there (see
 * `inline-orchestrator.ts`). `@workflow/core/runtime` (the flow route, and
 * every other entry) registers it (see `quickjs-engine.ts`).
 */

import { WorkflowRuntimeError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';

/** Lazy imports of the QuickJS engine's modules. */
export interface QuickJSEngine {
  spec8(): Promise<typeof import('./spec8/quickjs-entrypoint.js')>;
  spec9(): Promise<typeof import('./spec9/quickjs-entrypoint.js')>;
  runtime(): Promise<typeof import('./quickjs-runtime.js')>;
}

// On `globalThis` (see `globalSingleton`): the flow route's copy of the
// runtime registers it, and a delivery in another copy finds it.
const registry = globalSingleton('@workflow/core//quickjsEngine', 1, () => ({
  engine: undefined as QuickJSEngine | undefined,
}));

/** Registers the QuickJS engine (see `quickjs-engine.ts`). @internal */
export function registerQuickJSEngine(engine: QuickJSEngine): void {
  registry.engine = engine;
}

/** Whether this process can run QuickJS workflows. @internal */
export function isQuickJSEngineRegistered(): boolean {
  return registry.engine !== undefined;
}

/**
 * The QuickJS engine. Throws a retryable error where it is not bundled, so a
 * QuickJS run that reached such a process anyway (an inline delivery whose
 * engine could not be told in advance) is redelivered to the flow route,
 * which has it.
 */
export function quickJSEngine(): QuickJSEngine {
  if (!registry.engine) {
    throw new WorkflowRuntimeError(
      'The QuickJS workflow engine is not bundled in this function; the delivery is retried where it is.'
    );
  }
  return registry.engine;
}

/** The QuickJS engine, if registered. @internal */
export function maybeQuickJSEngine(): QuickJSEngine | undefined {
  return registry.engine;
}
