/**
 * The QuickJS workflow engine's registration (see `quickjs-loader.ts`).
 * Called by `@workflow/core/runtime`'s `workflowEntrypoint()`, so every flow
 * entry built on it has the engine; the per-workflow inline entries use
 * `flow-entrypoint.ts`'s `workflowEntrypoint()` directly, without it.
 *
 * A call rather than a side-effect import: bundlers that treat modules as
 * free of side effects (Nitro's Rollup build) drop a bare import.
 */
import {
  isQuickJSEngineRegistered,
  registerQuickJSEngine,
} from './quickjs-loader.js';

export function registerBundledQuickJSEngine(): void {
  if (isQuickJSEngineRegistered()) return;
  registerQuickJSEngine({
    spec8: () => import('./spec8/quickjs-entrypoint.js'),
    spec9: () => import('./spec9/quickjs-entrypoint.js'),
    runtime: () => import('./quickjs-runtime.js'),
  });
}
