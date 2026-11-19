/**
 * Build-time entry point for the QuickJS engine's baseline heap: the
 * workflow builder calls {@link createPrebuiltQuickJSBaseline} on the flow
 * bundle and passes the result to `workflowEntrypoint` as
 * `quickjsBaseline`, so deployed instances restore the heap instead of
 * evaluating the bundle to build it.
 */
export {
  createPrebuiltQuickJSBaseline,
  type PrebuiltQuickJSBaseline,
  quickjsBaselineEngineId,
} from './quickjs-runtime.js';
