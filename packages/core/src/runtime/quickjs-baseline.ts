/**
 * Build-time entry point for the QuickJS engine's baseline heap: the
 * workflow builder calls {@link createPrebuiltQuickJSBaseline} on the flow
 * bundle, ships the asset next to the flow route as
 * {@link QUICKJS_BASELINE_ASSET}, and passes the header to
 * `workflowEntrypoint` as `quickjsBaseline` (with a `loadAsset` that reads
 * the file), so deployed instances restore the heap instead of evaluating
 * the bundle to build it.
 */
export {
  createPrebuiltQuickJSBaseline,
  type PrebuiltQuickJSBaseline,
  type PrebuiltQuickJSBaselineBuild,
  QUICKJS_BASELINE_ASSET,
  quickjsBaselineEngineId,
  type WorkflowAssetLoader,
} from './quickjs-runtime.js';
