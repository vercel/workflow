// Side-effect import: ensure `world.ts` is loaded so its module-load
// `globalThis[GetWorldFnKey] ??= getWorld` registration fires before any
// host route reaches `getWorldLazy()`. Without this, webpack/turbopack
// tree-shake `world.ts` out of routes that only use `start` (the most
// common host-side entry point) and `getWorldLazy()`'s dynamic-import
// fallback then fails because the bundler inlined `get-world-lazy.js`
// into the route bundle. Resolved to an empty stub via the `workflow`
// export condition in VM/step bundles, so this stays host-only.
// See `@workflow/core/src/runtime/world-init.ts` for the full rationale.
import '@workflow/core/runtime/world-init';

export type {
  Event,
  StopSleepOptions,
  StopSleepResult,
  WorkflowRun,
} from '@workflow/core/runtime';
export {
  getHookByToken,
  resumeHook,
  resumeWebhook,
} from '@workflow/core/runtime/resume-hook';
export {
  getRun,
  Run,
  type WorkflowReadableStream,
  type WorkflowReadableStreamOptions,
} from '@workflow/core/runtime/run';
export {
  type StartOptions,
  start,
} from '@workflow/core/runtime/start';
