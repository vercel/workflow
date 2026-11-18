// The runtime a generated per-workflow inline entry imports: the flow entry's
// `workflowEntrypoint()` without the QuickJS engine, so a Function that only
// starts and resumes runs does not carry it. An inline delivery of a QuickJS
// run is declined where the engine is not bundled; the flow route has it.
// Not a public API.
import '@workflow/core/runtime/world-init';

export { workflowEntrypoint } from '@workflow/core/runtime/flow-entrypoint';
