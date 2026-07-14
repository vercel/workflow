// Host-side side effect: defineHook().resume() and other top-level helpers can
// reach getWorldLazy() without importing `workflow/api`. The `workflow` export
// condition resolves this package entry to `workflow.js` inside VM/workflow
// bundles, so this init import stays out of sandboxed workflow code.
import '@workflow/core/runtime/world-init';

export * from '@workflow/core';
export * from './stdlib.js';
