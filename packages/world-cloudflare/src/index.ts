/**
 * `@workflow/world-cloudflare` (experimental): a World in which each workflow
 * run is a Cloudflare Durable Object that stores and runs it.
 *
 * A Worker using it must:
 *  - call `setupCloudflareWorld()` at module scope with its build's
 *    deployment id, the generated workflow route, and the QuickJS modules;
 *  - re-export `RunObject`, `TokenObject`, `StreamObject` and `StepRunner`
 *    from its entrypoint, bound as `WORKFLOW_RUNS`, `WORKFLOW_TOKENS` and
 *    `WORKFLOW_STREAMS` (see `e2e/wrangler.jsonc`);
 *  - run with `WORKFLOW_VM=quickjs`, the `nodejs_compat` compatibility flag,
 *    and `ctx.exports` available (a compatibility date of 2026-09-01 or
 *    later, or the `enable_ctx_exports` flag).
 *
 * See the package README for a complete setup.
 */
import { installQuickJSModules, type QuickJSModules } from './quickjs.js';
import { configureRuntime, type FlowRoute } from './runtime.js';
import { createCloudflareWorld } from './world.js';

export { RunObject } from './run-object.js';
export { StepRunner } from './step-runner.js';
export { StreamObject } from './stream-object.js';
export { TokenObject } from './token-object.js';
export { createCloudflareWorld };
export type { QuickJSModules };

export interface SetupOptions {
  deploymentId: string;
  /** `createFlowRoute` from the combined workflow bundle (see `buildCloudflareWorkflows` in `@workflow/world-cloudflare/build`). */
  createFlowRoute: () => FlowRoute;
  quickjs: QuickJSModules;
  /** `setWorld` from `workflow/runtime`, so the World becomes the active one. */
  setWorld: (world: ReturnType<typeof createCloudflareWorld>) => void;
}

/** Wire the World into this isolate. Safe at module scope (no I/O). */
export function setupCloudflareWorld(options: SetupOptions) {
  installQuickJSModules(options.quickjs);
  configureRuntime({
    deploymentId: options.deploymentId,
    createFlowRoute: options.createFlowRoute,
  });
  const world = createCloudflareWorld();
  options.setWorld(world);
  return world;
}
