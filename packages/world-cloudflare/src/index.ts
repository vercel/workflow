/**
 * `@workflow/world-cloudflare`: a proof-of-concept World in which each
 * workflow run is a Cloudflare Durable Object that stores and runs it.
 *
 * A Worker using it must:
 *  - call `setupCloudflareWorld()` at module scope with its build's
 *    deployment id, the generated workflow route, and the QuickJS modules;
 *  - re-export `RunObject`, `TokenObject`, `StreamObject` and `StepRunner`
 *    from its entrypoint, bound as `WORKFLOW_RUNS`, `WORKFLOW_TOKENS` and
 *    `WORKFLOW_STREAMS` (see `poc/wrangler.jsonc`);
 *  - run with `WORKFLOW_VM=quickjs` and the `nodejs_compat` and
 *    `enable_ctx_exports` compatibility flags.
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
  /** `createFlowRoute` from the combined workflow bundle (see poc/build.mjs). */
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
